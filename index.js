const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

const isProduction = process.env.NODE_ENV === "production";
const logDev = (...args) => {
  if (!isProduction) {
    console.log(...args);
  }
};

function normalizePrivateKey(value) {
  if (!value) return "";
  return value.toString().replace(/\\n/g, "\n").trim();
}

function sanitizeString(value, maxLen = 512) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLen);
}

function isValidUid(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function isValidCallId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function isValidToken(value) {
  return value.length >= 20 && value.length <= 4096;
}

const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "").trim();
const FIREBASE_CLIENT_EMAIL = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
const FIREBASE_PRIVATE_KEY = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

logDev("ENV PROJECT ID:", FIREBASE_PROJECT_ID || "<missing>");
logDev("ENV CLIENT EMAIL:", FIREBASE_CLIENT_EMAIL || "<missing>");
logDev("ENV PRIVATE KEY EXISTS:", !!FIREBASE_PRIVATE_KEY);

let db = null;
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
    logDev("[Firebase] Admin initialized with explicit Render env config");
  }
  db = admin.firestore();
  logDev("DB project:", admin.app().options.projectId);
} catch (e) {
  console.error("[Firebase] init error");
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

app.post("/save-token", async (req, res) => {
  const userId = sanitizeString(req.body?.userId, 128);
  const token = sanitizeString(req.body?.token, 4096);
  if (!userId || !token) {
    return res.status(400).json({ ok: false, error: "userId and token required" });
  }
  if (!isValidUid(userId)) {
    return res.status(400).json({ ok: false, error: "invalid userId" });
  }
  if (!isValidToken(token)) {
    return res.status(400).json({ ok: false, error: "invalid token" });
  }
  if (!db) {
    return res.status(500).json({ ok: false, error: "Firestore unavailable" });
  }
  try {
    await db.collection("users").doc(userId).set(
      {
        tokens: admin.firestore.FieldValue.arrayUnion(token),
      },
      { merge: true }
    );
    const doc = await db.collection("users").doc(userId).get();
    const data = doc.data() || {};
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    return res.json({ ok: true, userId, tokenCount: tokens.length });
  } catch (e) {
    console.error("save-token failed");
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/tokens/:userId", async (req, res) => {
  const userId = sanitizeString(req.params?.userId, 128);
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId required" });
  }
  if (!isValidUid(userId)) {
    return res.status(400).json({ ok: false, error: "invalid userId" });
  }
  if (!db) {
    return res.status(500).json({ ok: false, error: "Firestore unavailable" });
  }
  try {
    const doc = await db.collection("users").doc(userId).get();
    const tokens = Array.isArray(doc.data()?.tokens) ? doc.data().tokens : [];
    return res.json({
      ok: true,
      userId,
      tokenCount: tokens.length,
    });
  } catch (e) {
    console.error("tokens lookup failed");
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/call-invite", async (req, res) => {
  const callId = sanitizeString(req.body?.callId, 128);
  const callerUid = sanitizeString(req.body?.callerUid, 128);
  const callerName = sanitizeString(req.body?.callerName, 120);
  const calleeUid = sanitizeString(req.body?.calleeUid, 128);
  const chatId = sanitizeString(req.body?.chatId, 128);
  const isVideo = Boolean(req.body?.isVideo);
  if (!callId || !callerUid || !calleeUid) {
    return res
      .status(400)
      .json({ ok: false, error: "callId, callerUid, calleeUid required" });
  }
  if (!isValidCallId(callId)) {
    return res.status(400).json({ ok: false, error: "invalid callId" });
  }
  if (!isValidUid(callerUid) || !isValidUid(calleeUid)) {
    return res.status(400).json({ ok: false, error: "invalid uid" });
  }
  if (admin.apps.length === 0) {
    return res
      .status(500)
      .json({ ok: false, error: "Firebase Admin not initialized" });
  }

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
      callId,
      callerUid,
      callerName: title,
      calleeUid,
      isVideo: String(!!isVideo),
      ...(chatId ? { chatId } : {}),
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
  const tokensInput = Array.isArray(req.body?.tokens) ? req.body.tokens : [];
  const tokens = tokensInput
    .map((token) => sanitizeString(token, 4096))
    .filter((token) => isValidToken(token))
    .slice(0, 500);
  const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};
  const notificationTitle = sanitizeString(req.body?.notificationTitle, 120);
  const notificationBody = sanitizeString(req.body?.notificationBody, 240);
  const highPriority = Boolean(req.body?.highPriority);
  if (tokens.length === 0) {
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
  socket.on("register", ({ uid }) => {
    const cleanUid = sanitizeString(uid, 128);
    if (!isValidUid(cleanUid)) return;
    socket.join(`uid:${cleanUid}`);
    socket.data.uid = cleanUid;
  });

  socket.on("call_invite_user", ({ uid, ...rest }) => {
    const targetUid = sanitizeString(uid, 128);
    if (!isValidUid(targetUid)) return;
    io.to(`uid:${targetUid}`).emit("call_invite", {
      ...rest,
      uid: targetUid,
    });
  });

  socket.on("webrtc_offer_user", ({ uid, callId, fromUid, sdp }) => {
    const targetUid = sanitizeString(uid, 128);
    const cleanCallId = sanitizeString(callId, 128);
    const cleanFromUid = sanitizeString(fromUid, 128);
    if (!isValidUid(targetUid) || !isValidCallId(cleanCallId) || !isValidUid(cleanFromUid)) return;
    io.to(`uid:${targetUid}`).emit("webrtc_offer", {
      uid: targetUid,
      callId: cleanCallId,
      fromUid: cleanFromUid,
      sdp,
    });
  });

  socket.on("webrtc_answer_user", ({ uid, callId, fromUid, sdp }) => {
    const targetUid = sanitizeString(uid, 128);
    const cleanCallId = sanitizeString(callId, 128);
    const cleanFromUid = sanitizeString(fromUid, 128);
    if (!isValidUid(targetUid) || !isValidCallId(cleanCallId) || !isValidUid(cleanFromUid)) return;
    io.to(`uid:${targetUid}`).emit("webrtc_answer", {
      uid: targetUid,
      callId: cleanCallId,
      fromUid: cleanFromUid,
      sdp,
    });
  });

  socket.on("webrtc_ice_candidate_user", ({ uid, callId, fromUid, candidate }) => {
    const targetUid = sanitizeString(uid, 128);
    const cleanCallId = sanitizeString(callId, 128);
    const cleanFromUid = sanitizeString(fromUid, 128);
    if (!isValidUid(targetUid) || !isValidCallId(cleanCallId) || !isValidUid(cleanFromUid)) return;
    io.to(`uid:${targetUid}`).emit("webrtc_ice_candidate", {
      uid: targetUid,
      callId: cleanCallId,
      fromUid: cleanFromUid,
      candidate,
    });
  });

  socket.on("webrtc_hangup_user", ({ uid, callId, fromUid }) => {
    const targetUid = sanitizeString(uid, 128);
    const cleanCallId = sanitizeString(callId, 128);
    const cleanFromUid = sanitizeString(fromUid, 128);
    if (!isValidUid(targetUid) || !isValidCallId(cleanCallId) || !isValidUid(cleanFromUid)) return;
    io.to(`uid:${targetUid}`).emit("webrtc_hangup", {
      uid: targetUid,
      callId: cleanCallId,
      fromUid: cleanFromUid,
    });
  });

  socket.on("join", ({ callId, uid }) => {
    const cleanCallId = sanitizeString(callId, 128);
    const cleanUid = sanitizeString(uid, 128);
    if (!isValidCallId(cleanCallId)) return;
    socket.join(cleanCallId);
    socket.data.callId = cleanCallId;
    socket.data.uid = cleanUid;
  });

  socket.on("offer", ({ callId, sdp, type, from }) => {
    const cleanCallId = sanitizeString(callId, 128);
    if (!isValidCallId(cleanCallId)) return;
    socket.to(cleanCallId).emit("offer", {
      sdp,
      type: sanitizeString(type, 24),
      from: sanitizeString(from, 128),
    });
  });

  socket.on("answer", ({ callId, sdp, type, from }) => {
    const cleanCallId = sanitizeString(callId, 128);
    if (!isValidCallId(cleanCallId)) return;
    socket.to(cleanCallId).emit("answer", {
      sdp,
      type: sanitizeString(type, 24),
      from: sanitizeString(from, 128),
    });
  });

  socket.on("candidate", ({ callId, candidate, sdpMid, sdpMLineIndex, from }) => {
    const cleanCallId = sanitizeString(callId, 128);
    if (!isValidCallId(cleanCallId)) return;
    socket.to(cleanCallId).emit("candidate", {
      candidate,
      sdpMid: sanitizeString(sdpMid, 64),
      sdpMLineIndex,
      from: sanitizeString(from, 128),
    });
  });

  socket.on("end", ({ callId }) => {
    const cleanCallId = sanitizeString(callId, 128);
    if (!isValidCallId(cleanCallId)) return;
    socket.to(cleanCallId).emit("end", {});
  });
});

server.listen(PORT, () => {
  logDev("Server started");
  logDev("Tokens route loaded");
  if (app._router?.stack) {
    app._router.stack.forEach((r) => {
      if (r.route) logDev("Route:", r.route.path);
    });
  }
  console.log(`Signaling server listening on ${PORT}`);
});
