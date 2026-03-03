const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ─── CONFIG (set these as Environment Variables on Render) ───────────────────
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN     || "mySecretToken123";
const WA_TOKEN         = process.env.WA_TOKEN         || "YOUR_WHATSAPP_PERMANENT_TOKEN";
const WA_PHONE_ID      = process.env.WA_PHONE_ID      || "YOUR_PHONE_NUMBER_ID";
const VF_API_KEY       = process.env.VF_API_KEY       || "YOUR_VOICEFLOW_API_KEY";
const VF_VERSION_ID    = process.env.VF_VERSION_ID    || "production"; // or "development"
// ────────────────────────────────────────────────────────────────────────────

const WA_API_URL = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;

// ── 1. WEBHOOK VERIFICATION (Meta calls this once to verify your URL) ────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta!");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ── 2. RECEIVE WHATSAPP MESSAGE ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always reply 200 fast to Meta

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from    = message.from;           // User's WhatsApp number
    const msgType = message.type;
    let userText  = "";

    if (msgType === "text") {
      userText = message.text.body;
    } else if (msgType === "interactive") {
      // Button reply or list reply
      userText =
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id   ||
        "button_clicked";
    } else {
      return; // Ignore audio/image/etc for now
    }

    console.log(`📩 Message from ${from}: ${userText}`);
    await handleVoiceflow(from, userText);

  } catch (err) {
    console.error("❌ Error handling message:", err.message);
  }
});

// ── 3. SEND TO VOICEFLOW & GET RESPONSE ──────────────────────────────────────
async function handleVoiceflow(userID, userMessage) {
  try {
    const response = await axios.post(
      `https://general-runtime.voiceflow.com/state/user/${encodeURIComponent(userID)}/interact`,
      {
        action: {
          type: "text",
          payload: userMessage,
        },
      },
      {
        headers: {
          Authorization: VF_API_KEY,
          versionID: VF_VERSION_ID,
          "Content-Type": "application/json",
        },
      }
    );

    const traces = response.data;
    await processVoiceflowTraces(userID, traces);
  } catch (err) {
    console.error("❌ Voiceflow error:", err.response?.data || err.message);
    await sendTextMessage(userID, "Sorry, something went wrong. Please try again.");
  }
}

// ── 4. PROCESS VOICEFLOW TRACES → SEND TO WHATSAPP ───────────────────────────
async function processVoiceflowTraces(userID, traces) {
  for (const trace of traces) {
    console.log("🔍 Trace type:", trace.type, JSON.stringify(trace.payload)?.slice(0, 100));

    if (trace.type === "text" || trace.type === "speak") {
      // ── Full text (no cutting!) ──
      const text = trace.payload?.message || trace.payload?.slate?.content
        ?.map(block => block.children?.map(c => c.text).join(""))
        .join("\n") || "";

      if (text.trim()) await sendTextMessage(userID, text);

    } else if (trace.type === "visual" || trace.payload?.cards) {
      // ── CAROUSEL → WhatsApp Interactive List ──
      const cards = trace.payload?.cards || [];
      if (cards.length > 0) {
        await sendCarouselAsList(userID, cards);
      }

    } else if (trace.type === "choice") {
      // ── Buttons ──
      const buttons = trace.payload?.buttons || [];
      if (buttons.length > 0 && buttons.length <= 3) {
        await sendButtonMessage(userID, "Please choose:", buttons);
      } else if (buttons.length > 3) {
        // WhatsApp max 3 buttons → use list instead
        await sendListMessage(userID, "Please choose an option:", buttons);
      }

    } else if (trace.type === "carousel") {
      // ── Voiceflow Carousel block ──
      const items = trace.payload?.cards || [];
      if (items.length > 0) await sendCarouselAsList(userID, items);
    }

    // Small delay between messages so they arrive in order
    await sleep(300);
  }
}

// ── 5. WHATSAPP SENDERS ───────────────────────────────────────────────────────

// Plain text (handles long text — no cutting)
async function sendTextMessage(to, text) {
  // WhatsApp max is 4096 chars — split if needed
  const chunks = splitText(text, 4000);
  for (const chunk of chunks) {
    await waPost({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: chunk },
    });
    await sleep(200);
  }
}

// Up to 3 reply buttons
async function sendButtonMessage(to, bodyText, buttons) {
  const waButtons = buttons.slice(0, 3).map((btn, i) => ({
    type: "reply",
    reply: {
      id: btn.request?.payload?.label || `btn_${i}`,
      title: btn.name.slice(0, 20), // WhatsApp max 20 chars
    },
  }));

  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: { buttons: waButtons },
    },
  });
}

// List message for > 3 options
async function sendListMessage(to, bodyText, buttons) {
  const rows = buttons.map((btn, i) => ({
    id: btn.request?.payload?.label || `opt_${i}`,
    title: btn.name.slice(0, 24),
  }));

  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText.slice(0, 1024) },
      action: {
        button: "View Options",
        sections: [{ title: "Options", rows: rows.slice(0, 10) }],
      },
    },
  });
}

// Carousel → WhatsApp List (best free alternative — carousels not in WA Cloud API)
async function sendCarouselAsList(to, cards) {
  if (cards.length === 0) return;

  // Send each card as a separate text with its buttons
  for (const card of cards) {
    const title    = card.title || "";
    const desc     = card.description?.text || card.description || "";
    const imageUrl = card.imageUrl || "";
    const buttons  = card.buttons || [];

    let cardText = `*${title}*`;
    if (desc) cardText += `\n${desc}`;

    // If card has an image — send as image with caption
    if (imageUrl) {
      await waPost({
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: {
          link: imageUrl,
          caption: cardText.slice(0, 1024),
        },
      });
    } else {
      await sendTextMessage(to, cardText);
    }

    // Send buttons for this card
    if (buttons.length > 0 && buttons.length <= 3) {
      await sendButtonMessage(to, "Choose an option:", buttons);
    } else if (buttons.length > 3) {
      await sendListMessage(to, "Choose an option:", buttons);
    }

    await sleep(400);
  }
}

// ── 6. HELPERS ────────────────────────────────────────────────────────────────
async function waPost(payload) {
  try {
    const res = await axios.post(WA_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.log("✅ WA sent:", res.data?.messages?.[0]?.id);
  } catch (err) {
    console.error("❌ WA send error:", JSON.stringify(err.response?.data || err.message));
  }
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 7. START SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
