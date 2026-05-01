const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

function normalizePrivateKey(value) {
  if (!value) return "";
  return value.toString().replace(/\\n/g, "\n").trim();
}

const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "").trim();
const FIREBASE_CLIENT_EMAIL = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
const FIREBASE_PRIVATE_KEY = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

console.log("ENV PROJECT ID:", FIREBASE_PROJECT_ID || "<missing>");
console.log("ENV CLIENT EMAIL:", FIREBASE_CLIENT_EMAIL || "<missing>");
console.log("ENV PRIVATE KEY EXISTS:", !!FIREBASE_PRIVATE_KEY);

try {
  if (admin.apps.length === 0) {
    if (!FIREBASE_PROJECT_ID) {
      throw new Error("FIREBASE_PROJECT_ID is missing");
    }
    if (!FIREBASE_CLIENT_EMAIL) {
      throw new Error("FIREBASE_CLIENT_EMAIL is missing");
    }
    if (!FIREBASE_PRIVATE_KEY) {
      throw new Error("FIREBASE_PRIVATE_KEY is missing");
    }

    admin.initializeApp({
      projectId: FIREBASE_PROJECT_ID,
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY,
      }),
    });
    console.log("[Firebase] Admin initialized with explicit Render env config");
  }
} catch (e) {
  console.error("[Firebase] init error:", e.message);
}

const PORT = process.env.PORT || 3001;
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "webrtc-signaling" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function getDb() {
  if (admin.apps.length === 0) return null;
  return admin.firestore();
}

app.post("/save-token", async (req, res) => {
  const userId = (req.body?.userId || "").toString().trim();
  const token = (req.body?.token || "").toString().trim();
  if (!userId || !token) {
    return res.status(400).json({ ok: false, error: "userId and token required" });
  }
  const db = getDb();
  if (!db) {
    return res.status(500).json({ ok: false, error: "Firestore unavailable" });
  }
  try {
    console.log("Saving token:", userId, token);
    await db.collection("users").doc(userId).set(
      {
        tokens: admin.firestore.FieldValue.arrayUnion(token),
      },
      { merge: true }
    );
    const doc = await db.collection("users").doc(userId).get();
    const tokens = Array.isArray(doc.data()?.tokens) ? doc.data().tokens : [];
    console.log("Fetched tokens after save:", tokens);
    return res.json({ ok: true, userId, tokenCount: tokens.length });
  } catch (e) {
    console.error("save-token failed:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/tokens/:userId", async (req, res) => {
  const userId = (req.params?.userId || "").toString().trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId required" });
  }
  const db = getDb();
  if (!db) {
    return res.status(500).json({ ok: false, error: "Firestore unavailable" });
  }
  try {
    const doc = await db.collection("users").doc(userId).get();
    const tokens = Array.isArray(doc.data()?.tokens) ? doc.data().tokens : [];
    console.log("Fetched tokens:", userId, tokens);
    return res.json({
      ok: true,
      userId,
      tokenCount: tokens.length,
      tokens,
    });
  } catch (e) {
    console.error("tokens lookup failed:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/call-invite", async (req, res) => {
  const { callId, callerUid, callerName, calleeUid, isVideo, chatId } =
    req.body || {};
  if (!callId || !callerUid || !calleeUid) {
    return res
      .status(400)
      .json({ ok: false, error: "callId, callerUid, calleeUid required" });
  }
  if (admin.apps.length === 0) {
    return res
      .status(500)
      .json({ ok: false, error: "Firebase Admin not initialized" });
  }

  const db = getDb();
  if (!db) {
    return res
      .status(500)
      .json({ ok: false, error: "Firestore unavailable" });
  }
  const doc = await db.collection("users").doc(String(calleeUid).trim()).get();
  const tokens = Array.isArray(doc.data()?.tokens) ? doc.data().tokens : [];
  if (tokens.length === 0) {
    return res.status(404).json({ ok: false, error: "No tokens for calleeUid" });
  }

  const title = (callerName || "Incoming call").toString();
  const body = isVideo ? "Incoming video call" : "Incoming voice call";
  const message = {
    tokens,
    data: {
      type: "call_invite",
      callId: String(callId),
      callerUid: String(callerUid),
      callerName: title,
      calleeUid: String(calleeUid),
      isVideo: String(!!isVideo),
      ...(chatId ? { chatId: String(chatId) } : {}),
      title,
      body,
    },
    notification: { title, body },
    android: { priority: "high", ttl: 30000 },
    apns: { headers: { "apns-priority": "10" } },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    return res.json({
      ok: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Backward-compatible generic notify endpoint.
app.post("/api/notify", async (req, res) => {
  const { tokens, data, notificationTitle, notificationBody, highPriority } =
    req.body || {};
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ ok: false, error: "tokens required" });
  }
  if (admin.apps.length === 0) {
    return res
      .status(500)
      .json({ ok: false, error: "Firebase Admin not initialized" });
  }
  try {
    const message = {
      tokens,
      data: data || {},
      ...(notificationTitle
        ? { notification: { title: notificationTitle, body: notificationBody || "" } }
        : {}),
      android: { priority: highPriority ? "high" : "normal" },
    };
    const response = await admin.messaging().sendEachForMulticast(message);
    return res.json({
      ok: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

io.on("connection", (socket) => {
  socket.on("join", ({ callId, uid }) => {
    if (!callId) return;
    socket.join(callId);
    socket.data.callId = callId;
    socket.data.uid = uid || "";
  });

  socket.on("offer", ({ callId, sdp, type, from }) => {
    if (!callId) return;
    socket.to(callId).emit("offer", { sdp, type, from });
  });

  socket.on("answer", ({ callId, sdp, type, from }) => {
    if (!callId) return;
    socket.to(callId).emit("answer", { sdp, type, from });
  });

  socket.on("candidate", ({ callId, candidate, sdpMid, sdpMLineIndex, from }) => {
    if (!callId) return;
    socket.to(callId).emit("candidate", {
      candidate,
      sdpMid,
      sdpMLineIndex,
      from
    });
  });

  socket.on("end", ({ callId }) => {
    if (!callId) return;
    socket.to(callId).emit("end", {});
  });
});

server.listen(PORT, () => {
  console.log("Server started");
  console.log("Tokens route loaded");
  if (app._router?.stack) {
    app._router.stack.forEach((r) => {
      if (r.route) console.log("Route:", r.route.path);
    });
  }
  console.log(`Signaling server listening on ${PORT}`);
});
