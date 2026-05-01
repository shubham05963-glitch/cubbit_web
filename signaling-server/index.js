const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

try {
  if (admin.apps.length === 0) {
    admin.initializeApp();
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

// Debug token store for this backend instance.
const tokensByUser = new Map();

app.post("/save-token", (req, res) => {
  const userId = (req.body?.userId || "").toString().trim();
  const token = (req.body?.token || "").toString().trim();
  if (!userId || !token) {
    return res.status(400).json({ ok: false, error: "userId and token required" });
  }
  const set = tokensByUser.get(userId) || new Set();
  set.add(token);
  tokensByUser.set(userId, set);
  return res.json({ ok: true, userId, tokenCount: set.size });
});

app.get("/tokens/:userId", async (req, res) => {
  const userId = (req.params?.userId || "").toString().trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId required" });
  }
  const set = tokensByUser.get(userId) || new Set();
  return res.json({
    ok: true,
    userId,
    tokenCount: set.size,
    tokens: [...set],
  });
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

  const tokens = [...(tokensByUser.get(String(calleeUid).trim()) || new Set())];
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
