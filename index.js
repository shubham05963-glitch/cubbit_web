const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const app = express();
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
  console.log(`Signaling server listening on ${PORT}`);
});
