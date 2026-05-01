const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

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
