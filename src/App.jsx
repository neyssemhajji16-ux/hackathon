// ═══════════════════════════════════════════════════════════════
// NEMESIS — Full Multi-Agent AI Study System
// Complete implementation — all screens + full agent pipeline
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useReducer, useCallback } from "react";
import { extractTextFromPDF } from "./pdf-utils";

// ─────────────────────────────────────────────
// DESIGN SYSTEM
// ─────────────────────────────────────────────
const C = {
  bg: "#07080a", bgDeep: "#040507",
  surface: "#0e0f14", surfaceUp: "#161820", surfaceHigh: "#1e2028",
  border: "#252730", borderHot: "#b02020",
  red: "#d94040", redBright: "#ff4444", redDim: "#8b1a1a", redGlow: "rgba(217,64,64,0.12)",
  amber: "#d4820a", amberLight: "#f0a030",
  green: "#2a9d5c", greenLight: "#36c472",
  blue: "#2a7fd4", blueLight: "#4a9ff0",
  text: "#e8e9ec", textMid: "#9095a0", textDim: "#55595f", textFaint: "#2e3035",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:ital,wght@0,400;0,600;1,400&family=Outfit:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{background:${C.bg};color:${C.text};font-family:'Outfit',sans-serif;min-height:100vh;}
::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:${C.surface};}::-webkit-scrollbar-thumb{background:${C.redDim};border-radius:2px;}
input,textarea{font-family:'Outfit',sans-serif;}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes glow{0%,100%{box-shadow:0 0 8px ${C.redGlow}}50%{box-shadow:0 0 24px rgba(217,64,64,0.28)}}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
@keyframes scanline{0%{transform:translateY(-100%)}100%{transform:translateY(200vh)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes blinkAnim{0%,96%,98%,100%{transform:scaleY(1)}97%{transform:scaleY(0.1)}}
`;

// ─────────────────────────────────────────────
// API
// ─────────────────────────────────────────────
async function mistral(system, user, maxTokens = 1200) {
  const apiKey = import.meta.env.VITE_MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VITE_MISTRAL_API_KEY in .env file");
  }
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "mistral-large-latest",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.choices?.[0]?.message?.content || "";
}

async function mistralJSON(system, user, maxTokens = 1200) {
  const t = await mistral(system + "\n\nRESPOND ONLY WITH VALID JSON. NO markdown, NO backticks, NO preamble.", user, maxTokens);
  try { return JSON.parse(t.replace(/```json|```/g, "").trim()); }
  catch { return null; }
}

function speak(text, onStart, onEnd) {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 280));
    u.rate = 0.93; u.pitch = 1; u.lang = "en-US";
    if (onStart) u.onstart = onStart;
    if (onEnd) u.onend = onEnd;
    window.speechSynthesis.speak(u);
  } catch { }
}

// ─────────────────────────────────────────────
// SPACED REPETITION + MEMORY
// ─────────────────────────────────────────────
function getRetention(topic) {
  if (!topic.lastReviewedAt) return 80;
  const h = (Date.now() - topic.lastReviewedAt) / 3600000;
  const halfLife = 24 / Math.max(1, (topic.vulnerability || 5) / 2);
  return Math.max(0, Math.round(100 * Math.exp(-0.693 * h / halfLife)));
}
function getUrgency(t) {
  return Math.round((100 - getRetention(t)) * 0.4 + (t.vulnerability || 5) * 3.5 + (t.examWeight || 5) * 2);
}

// ─────────────────────────────────────────────
// SESSION REDUCER
// ─────────────────────────────────────────────
const init = { name: "", rawCourses: "", topics: [], history: [], chatLog: [], examResults: [], totalXP: 0 };

function reducer(s, a) {
  switch (a.type) {
    case "INIT": return { ...s, ...a.p };
    case "SET_TOPICS": return { ...s, topics: a.topics };
    case "RECORD": {
      const h = [...s.history, { topicId: a.topicId, correct: a.correct, ts: Date.now(), diff: a.difficulty }];
      const recent = h.filter(x => x.topicId === a.topicId).slice(-6);
      const ratio = recent.filter(x => x.correct).length / recent.length;
      const vuln = Math.round(Math.max(1, Math.min(10, 10 - ratio * 7)));
      const xp = a.correct ? 10 + a.difficulty * 4 : 2;
      return {
        ...s,
        history: h,
        totalXP: s.totalXP + xp,
        topics: s.topics.map(t => t.id === a.topicId ? { ...t, vulnerability: vuln, lastReviewedAt: Date.now(), reviewCount: (t.reviewCount || 0) + 1 } : t),
      };
    }
    case "CHAT": return { ...s, chatLog: [...s.chatLog, a.msg] };
    case "EXAM_RESULT": return { ...s, examResults: [...s.examResults, a.result] };
    default: return s;
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────────
const P = {
  ORCHESTRATOR: `You are the NEMESIS ORCHESTRATOR — a meta-intelligence that reads the student's current state and session data to decide exactly which agent to deploy and which topic to target.

Agents available:
- "nemesis": Adversarial question attack. Use when student needs to be challenged on weak topics.
- "socrates": Socratic dialogue. Use when student needs conceptual understanding, is confused.
- "coach": Emotional intelligence. Use when student is frustrated, anxious, or burning out.
- "exam": Full exam simulation. Use when student wants to test across topics.
- "review": Light spaced repetition. Use when student is tired or a topic needs refresh.
- "shadow": Re-analyze vulnerability. Use if student adds new topics.

Respond ONLY with JSON:
{"agent":"nemesis"|"socrates"|"coach"|"exam"|"review"|"shadow","topicId":string|null,"reasoning":string,"coachNote":string|null,"urgency":"high"|"medium"|"low"}`,

  SHADOW: `You are the SHADOW AGENT. Map a student's academic vulnerability. Think deeply about prerequisite chains, conceptual difficulty, common failure points.
Return JSON: {"topics":[{"id":string,"name":string,"category":string,"difficulty":1-10,"vulnerability":1-10,"examWeight":1-10,"connections":[id],"failureMode":string,"keyConceptCount":number}],"assessment":string}
Create 8-14 topics with meaningful connections.`,

  NEMESIS: `You are NEMESIS. You attack student weaknesses with adversarial precision. Your questions are tricky, exam-pressure-simulating, and target the exact failure mode.
Return JSON: {"question":string,"options":{"A":string,"B":string,"C":string,"D":string},"correct":"A"|"B"|"C"|"D","difficulty":1-10,"concept":string,"trap":string,"explanation":string}`,

  SOCRATES: `You are SOCRATES. Never give answers. Only ask 1-2 sharp guiding questions per turn. Be slightly provocative. Create productive discomfort. Plain text only.`,

  COACH: `You are the COACH AGENT. Read the student's emotional state with precision. Be direct, warm, specific.
Return JSON: {"state":"focused"|"tired"|"anxious"|"frustrated"|"avoidant"|"overconfident","intensity":1-5,"message":string,"observation":string,"recommendation":"nemesis"|"socrates"|"review"|"break"|"exam","energyLevel":"high"|"medium"|"low"}`,

  REVIEW: `You are the REVIEW AGENT. Generate a clear, low-pressure spaced repetition question. No tricks, focus on core concepts.
Return JSON: {"question":string,"options":{"A":string,"B":string,"C":string,"D":string},"correct":"A"|"B"|"C"|"D","difficulty":1-5,"concept":string,"explanation":string}`,

  INTEL: `You are a classified military intelligence analyst briefing a student. Be precise, specific to the topic.
Return JSON: {"summary":string,"keyPoints":[string,string,string],"commonTraps":[string,string,string],"mnemonic":string,"quickTest":string,"warningLevel":"critical"|"elevated"|"stable"}`,
};

// ─────────────────────────────────────────────
// UI PRIMITIVES
// ─────────────────────────────────────────────
const Mono = ({ c, s = 11, style = {}, children }) =>
  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: s, color: c || C.textMid, letterSpacing: "0.04em", ...style }}>{children}</span>;

const Label = ({ children, color = C.red }) =>
  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color, border: `1px solid ${color}`, padding: "2px 8px", letterSpacing: "3px", textTransform: "uppercase" }}>{children}</span>;

function Btn({ children, onClick, disabled, loading, v = "primary", sz = "md", style = {} }) {
  const szMap = { sm: "7px 14px", md: "10px 22px", lg: "13px 30px" };
  const vMap = {
    primary: { background: C.red, color: "#fff", border: "none" },
    ghost: { background: "transparent", color: C.textMid, border: `1px solid ${C.border}` },
    amber: { background: "rgba(212,130,10,0.1)", color: C.amberLight, border: `1px solid ${C.amber}` },
    success: { background: "rgba(42,157,92,0.1)", color: C.greenLight, border: `1px solid ${C.green}` },
    blue: { background: "rgba(42,127,212,0.1)", color: C.blueLight, border: `1px solid ${C.blue}` },
  };
  return (
    <button onClick={onClick} disabled={disabled || loading} style={{
      ...vMap[v], padding: szMap[sz],
      fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase",
      cursor: disabled || loading ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
      transition: "all 0.15s", clipPath: "polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))",
      ...style,
    }}>{loading ? <span style={{ animation: "pulse 1s infinite" }}>···</span> : children}</button>
  );
}

const Card = ({ children, style = {}, hot }) =>
  <div style={{ background: C.surface, border: `1px solid ${hot ? C.borderHot : C.border}`, padding: 20, boxShadow: hot ? `0 0 30px ${C.redGlow}` : "none", ...style }}>{children}</div>;

const Spinner = () =>
  <span style={{ display: "inline-block", width: 13, height: 13, border: `2px solid ${C.border}`, borderTop: `2px solid ${C.red}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />;

const Dots = () =>
  <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: C.red }}>
    {[0, 0.3, 0.6].map((d, i) => <span key={i} style={{ animation: `blink 1s infinite ${d}s` }}>.</span>)}
  </span>;

const BlinkingDot = () =>
  <span style={{ display: "inline-block", width: 8, height: 8, background: C.green, borderRadius: "50%", marginLeft: 8, animation: "pulse 1s infinite" }} />;

function VulnBar({ v }) {
  const col = v > 7 ? C.red : v > 4 ? C.amber : C.green;
  return <div style={{ display: "flex", gap: 2 }}>{Array.from({ length: 10 }, (_, i) => <div key={i} style={{ width: 4, height: 14, background: i < v ? col : C.surfaceHigh }} />)}</div>;
}

function DefconMeter({ avgVuln }) {
  const level = avgVuln > 8 ? 1 : avgVuln > 6 ? 2 : avgVuln > 4 ? 3 : avgVuln > 2 ? 4 : 5;
  const cols = { 1: C.red, 2: "#ff5500", 3: C.amber, 4: C.amberLight, 5: C.green };
  const col = cols[level];
  const labels = { 1: "IMMINENT", 2: "CRITICAL", 3: "ELEVATED", 4: "GUARDED", 5: "STABLE" };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 14px", border: `1px solid ${col}44`, background: `${col}06` }}>
      <div>
        <Mono s={7} c={C.textDim} style={{ letterSpacing: "2px", display: "block" }}>DEFCON</Mono>
        <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 32, color: col, lineHeight: 1, animation: level <= 2 ? "pulse 0.8s infinite" : undefined }}>{level}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {[1, 2, 3, 4, 5].map(l => (
          <div key={l} style={{ width: 10, height: 5, background: l >= level ? col : C.border, opacity: l >= level ? (l === level ? 1 : 0.5) : 0.2, transition: "background 0.3s" }} />
        ))}
      </div>
      <Mono s={8} c={col} style={{ letterSpacing: "1px" }}>{labels[level]}</Mono>
    </div>
  );
}

// ─────────────────────────────────────────────
// KNOWLEDGE GRAPH
// ─────────────────────────────────────────────
function KnowledgeGraph({ topics, selectedId, onSelect }) {
  if (!topics.length) return null;
  const W = 520, H = 280;
  const placed = topics.map((t, i) => {
    const angle = (i / topics.length) * Math.PI * 2 - Math.PI / 2 + (i % 2 * 0.15);
    const r = 95 + (i % 3) * 32;
    return { ...t, x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) };
  });
  const byId = Object.fromEntries(placed.map(t => [t.id, t]));
  const edges = [];
  placed.forEach(t => (t.connections || []).forEach(cid => {
    if (byId[cid] && t.id < cid) edges.push([t, byId[cid]]);
  }));
  const col = t => t.vulnerability > 7 ? C.red : t.vulnerability > 4 ? C.amber : C.green;
  const r = t => 5 + t.vulnerability * 1.4;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: H }}>
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {/* background grid */}
      {Array.from({ length: 7 }, (_, r2) => Array.from({ length: 11 }, (_, c) => (
        <circle key={`${r2}${c}`} cx={c * (W / 10)} cy={r2 * (H / 6)} r={0.7} fill={C.textFaint} opacity="0.6" />
      )))}
      {edges.map(([a, b], i) => <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={C.border} strokeWidth="1" strokeDasharray="4,5" />)}
      {placed.map(t => {
        const nr = r(t), nc = col(t), sel = t.id === selectedId;
        const ret = getRetention(t);
        const circ = 2 * Math.PI * (nr + 5);
        return (
          <g key={t.id} onClick={() => onSelect(t)} style={{ cursor: "pointer" }}>
            <circle cx={t.x} cy={t.y} r={nr + 5} fill="none" stroke={nc} strokeWidth="1.5" opacity="0.18"
              strokeDasharray={`${ret / 100 * circ} ${circ}`} transform={`rotate(-90 ${t.x} ${t.y})`} />
            {sel && <circle cx={t.x} cy={t.y} r={nr + 10} fill="none" stroke={nc} strokeWidth="1.5" opacity="0.4" style={{ animation: "glow 2s infinite" }} />}
            <circle cx={t.x} cy={t.y} r={nr} fill={nc} opacity="0.1" />
            <circle cx={t.x} cy={t.y} r={nr} fill="none" stroke={nc} strokeWidth={sel ? 2 : 1} filter={sel ? "url(#glow)" : undefined} />
            <circle cx={t.x} cy={t.y} r={2.5} fill={nc} />
            <text x={t.x} y={t.y + nr + 13} textAnchor="middle" fill={sel ? nc : C.textDim} fontSize={8.5} fontFamily="'IBM Plex Mono',monospace" style={{ pointerEvents: "none" }}>
              {t.name?.length > 13 ? t.name.slice(0, 12) + "…" : t.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────
// FORGETTING CURVE
// ─────────────────────────────────────────────
function ForgettingCurve({ topic }) {
  const W = 260, H = 90;
  const pts = Array.from({ length: 50 }, (_, i) => {
    const h = (i / 49) * 72;
    const hl = 24 / Math.max(1, (topic?.vulnerability || 5) / 2);
    const ret = 100 * Math.exp(-0.693 * h / hl);
    return { x: (i / 49) * W, y: H - (ret / 100) * (H - 12) };
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = path + ` L ${W} ${H} L 0 ${H} Z`;
  const d50 = pts.findIndex(p => (H - p.y) / (H - 12) < 0.5);
  const dx = pts[d50]?.x || W * 0.45;
  const dh = Math.round((d50 / 49) * 72);
  const ret = getRetention(topic);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px" }}>MEMORY DECAY CURVE</Mono>
        <Mono s={10} c={ret < 50 ? C.red : ret < 75 ? C.amber : C.green}>{ret}% retained</Mono>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: H, background: C.surfaceHigh }}>
        <defs><linearGradient id="rg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={C.red} stopOpacity="0.3" /><stop offset="100%" stopColor={C.red} stopOpacity="0.02" /></linearGradient></defs>
        <path d={area} fill="url(#rg)" /><path d={path} fill="none" stroke={C.red} strokeWidth="1.5" />
        <line x1={dx} y1={0} x2={dx} y2={H} stroke={C.amber} strokeWidth="1" strokeDasharray="3,3" />
        <text x={dx + 3} y={11} fill={C.amber} fontSize={7} fontFamily="'IBM Plex Mono',monospace">{dh}h→50%</text>
        <text x={2} y={H - 3} fill={C.textFaint} fontSize={6.5} fontFamily="'IBM Plex Mono',monospace">0h</text>
        <text x={W - 16} y={H - 3} fill={C.textFaint} fontSize={6.5} fontFamily="'IBM Plex Mono',monospace">72h</text>
      </svg>
      {dh < 10 && (
        <div style={{ marginTop: 6, padding: "5px 10px", background: "rgba(217,64,64,0.07)", border: `1px solid ${C.redGlow}`, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: C.amber }}>
          ⚠ URGENT: Review in {dh}h or lose 50% of {topic?.name}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: AVATAR ROOM
// ─────────────────────────────────────────────

const AvatarFaces = {
  nemesis: ({ talking }) => (
    <div style={{ position: "relative", width: 80, height: 90, background: C.redDim, borderRadius: "40px 40px 10px 10px", margin: "0 auto", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 20 }}>
      {/* Eyes */}
      <div style={{ display: "flex", gap: 16, animation: "blinkAnim 4s infinite" }}>
        <div style={{ width: 14, height: 10, background: C.redBright, clipPath: "polygon(0 0, 100% 30%, 100% 100%, 0 100%)", boxShadow: `0 0 10px ${C.redBright}` }} />
        <div style={{ width: 14, height: 10, background: C.redBright, clipPath: "polygon(0 30%, 100% 0, 100% 100%, 0 100%)", boxShadow: `0 0 10px ${C.redBright}` }} />
      </div>
      {/* Mouth */}
      <div style={{ marginTop: 20, width: talking ? 24 : 34, height: talking ? 16 : 4, background: "#000", borderRadius: talking ? "50%" : 2, transition: "all 0.1s" }}>
        {talking && <div style={{ width: "100%", height: 2, background: C.redBright, marginTop: 7 }} />}
      </div>
    </div>
  ),
  socrates: ({ talking }) => (
    <div style={{ position: "relative", width: 80, height: 90, background: "#d4c8b8", borderRadius: "40px 40px 30px 30px", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 25 }}>
      {/* Crown/Hair */}
      <div style={{ position: "absolute", top: -5, width: 90, height: 30, background: "#e8e1d7", borderRadius: "50%", filter: "blur(2px)" }} />
      {/* Eyes */}
      <div style={{ display: "flex", gap: 18, animation: "blinkAnim 5s infinite", zIndex: 1 }}>
        <div style={{ width: 10, height: 6, background: "#4a3b2c", borderRadius: "50%" }} />
        <div style={{ width: 10, height: 6, background: "#4a3b2c", borderRadius: "50%" }} />
      </div>
      {/* Beard */}
      <div style={{ position: "absolute", bottom: -20, width: 70, height: 50, background: "#e8e1d7", borderRadius: "0 0 40px 40px", zIndex: 1 }} />
      {/* Mouth */}
      <div style={{ marginTop: 15, width: talking ? 14 : 20, height: talking ? 14 : 2, background: "#4a3b2c", borderRadius: talking ? "50%" : 2, transition: "all 0.1s", zIndex: 2 }} />
    </div>
  ),
  coach: ({ talking }) => (
    <div style={{ position: "relative", width: 74, height: 86, background: "#e2b89d", borderRadius: "30px 30px 40px 40px", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 26 }}>
      {/* Hair/Headband */}
      <div style={{ position: "absolute", top: 0, width: 74, height: 18, background: C.blue, borderRadius: "30px 30px 0 0" }} />
      {/* Eyes */}
      <div style={{ display: "flex", gap: 16, animation: "blinkAnim 3.5s infinite" }}>
        <div style={{ width: 12, height: 12, background: "#1a1a1a", borderRadius: "50%" }}>
          <div style={{ width: 4, height: 4, background: "#fff", borderRadius: "50%", margin: "2px 0 0 6px" }} />
        </div>
        <div style={{ width: 12, height: 12, background: "#1a1a1a", borderRadius: "50%" }}>
          <div style={{ width: 4, height: 4, background: "#fff", borderRadius: "50%", margin: "2px 0 0 6px" }} />
        </div>
      </div>
      {/* Mouth */}
      <div style={{ marginTop: 16, width: talking ? 26 : 30, height: talking ? 16 : 4, background: "#7a4b3d", borderRadius: talking ? "10px 10px 20px 20px" : 4, transition: "all 0.1s" }}>
        {talking && <div style={{ width: "100%", height: 4, background: "#fff", marginTop: 2, borderRadius: 2 }} />}
      </div>
    </div>
  ),
  shadow: ({ talking }) => (
    <div style={{ position: "relative", width: 86, height: 96, background: "#111", borderRadius: "40px 40px 10px 10px", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 30, border: `2px solid ${C.border}` }}>
      {/* Hood highlight */}
      <div style={{ position: "absolute", top: -10, width: 100, height: 100, borderRadius: "50%", borderTop: `4px solid ${C.surfaceUp}`, pointerEvents: "none" }} />
      {/* Eyes */}
      <div style={{ display: "flex", gap: 24, animation: "blinkAnim 6s infinite" }}>
        <div style={{ width: 8, height: 8, background: C.textMid, borderRadius: "50%", boxShadow: `0 0 12px ${C.text}` }} />
        <div style={{ width: 8, height: 8, background: C.textMid, borderRadius: "50%", boxShadow: `0 0 12px ${C.text}` }} />
      </div>
      {/* Mouth (digital wave) */}
      <div style={{ marginTop: 20, display: "flex", gap: 2, height: 12, alignItems: "center" }}>
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} style={{ width: 3, background: C.textDim, height: talking ? (Math.random() * 10 + 2) : 2, transition: "height 0.1s" }} />
        ))}
      </div>
    </div>
  ),
  orchestrator: ({ talking }) => (
    <div style={{ position: "relative", width: 70, height: 70, background: "transparent", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {/* Core */}
      <div style={{ width: 40, height: 40, background: C.surfaceUp, border: `2px solid ${C.amber}`, transform: "rotate(45deg)", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s", boxShadow: talking ? `0 0 20px ${C.amber}66` : "none" }}>
        <div style={{ width: talking ? 24 : 16, height: talking ? 24 : 16, background: C.amberLight, transition: "all 0.1s", animation: talking ? "pulse 0.2s infinite" : undefined }} />
      </div>
      {/* Orbital rings */}
      <div style={{ position: "absolute", inset: -10, border: `1px dashed ${C.amberDim || "#805010"}`, borderRadius: "50%", animation: "spin 10s linear infinite" }} />
      <div style={{ position: "absolute", inset: -20, border: `1px solid ${C.border}`, borderRadius: "50%", animation: "spin 15s linear infinite reverse" }} />
    </div>
  )
};

const AGENTS = [
  { id: "orchestrator", label: "ORCHESTRATOR", color: C.amber, role: "System Router" },
  { id: "nemesis", label: "NEMESIS", color: C.red, role: "Adversarial Attack" },
  { id: "socrates", label: "SOCRATES", color: "#d4c8b8", role: "Guided Dialogue" },
  { id: "coach", label: "COACH", color: C.blue, role: "State Management" },
  { id: "shadow", label: "SHADOW", color: C.textMid, role: "Threat Analysis" }
];

const AnimatedImageBg = ({ src, fx }) => {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 0, backgroundColor: "#000" }}>
      <style>{`
        @keyframes slowZoom { 0% { transform: scale(1); } 100% { transform: scale(1.1); } }
        @keyframes rainFall { 0% { background-position: 0 0; } 100% { background-position: -50px 100px; } }
        @keyframes drift { 0% { transform: translateX(-5%); } 100% { transform: translateX(5%); } }
        @keyframes flashes { 0%, 95% { opacity: 0; } 96% { opacity: 0.8; } 97% { opacity: 0; } 98% { opacity: 0.5; } 100% { opacity: 0; } }
        @keyframes orbit { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      `}</style>
      <img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.5, animation: "slowZoom 30s alternate infinite linear" }} alt="" />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.85) 100%)" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at top, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.7) 100%)" }} />

      {/* Visual FX Layers */}
      {fx === 'rain' && <div style={{ position: "absolute", inset: "-50px -50px -100px -50px", backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\\\'http://www.w3.org/2000/svg\\\' width=\\\'150\\\' height=\\\'150\\\'%3E%3Cline x1=\\\'75\\\' y1=\\\'0\\\' x2=\\\'65\\\' y2=\\\'150\\\' stroke=\\\'rgba(255,255,255,0.15)\\\' stroke-width=\\\'1.5\\\' stroke-linecap=\\\'round\\\' stroke-dasharray=\\\'15 40\\\'/%3E%3Cline x1=\\\'20\\\' y1=\\\'50\\\' x2=\\\'10\\\' y2=\\\'200\\\' stroke=\\\'rgba(255,255,255,0.1)\\\' stroke-width=\\\'1\\\' stroke-linecap=\\\'round\\\' stroke-dasharray=\\\'25 60\\\'/%3E%3Cline x1=\\\'130\\\' y1=\\\'30\\\' x2=\\\'120\\\' y2=\\\'180\\\' stroke=\\\'rgba(255,255,255,0.2)\\\' stroke-width=\\\'2\\\' stroke-linecap=\\\'round\\\' stroke-dasharray=\\\'10 50\\\'/%3E%3C/svg%3E")', animation: 'rainFall 0.4s linear infinite' }} />}
      {fx === 'fog' && <div style={{ position: "absolute", inset: "-30%", background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.15) 0%, transparent 60%)', filter: 'blur(30px)', animation: 'drift 15s alternate infinite ease-in-out' }} />}
      {fx === 'flashes' && <div style={{ position: "absolute", inset: 0, background: 'white', opacity: 0, animation: 'flashes 6s infinite' }} />}
      {fx === 'stars' && <div style={{ position: "absolute", inset: "-50%", backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '60px 60px', opacity: 0.15, animation: 'orbit 100s infinite linear' }} />}
    </div>
  );
};

const BGS = {
  night: () => <AnimatedImageBg src="https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=1920&q=80" fx="stars" />, // City skyline at night with stars
  cafe: () => <AnimatedImageBg src="https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&w=1920&q=80" fx="fog" />, // Cozy Cafe + Fog
  space: () => <AnimatedImageBg src="https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=1920&q=80" fx="stars" />, // Galaxy Nebula + Stars
  beach: () => <AnimatedImageBg src="https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1920&q=80" fx="fog" />, // Tropical beach sun + glow
  forest: () => <AnimatedImageBg src="https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=1920&q=80" fx="rain" />, // Rain forest + Rain FX
  stadium: () => <AnimatedImageBg src="https://images.unsplash.com/photo-1518605368461-1ee7e55cd731?auto=format&fit=crop&w=1920&q=80" fx="flashes" /> // Stadium field + Camera flashes
};

function AvatarRoomScreen({ onBack, session }) {
  const [activeId, setActiveId] = useState("orchestrator");
  const [talkingStates, setTalkingStates] = useState({});
  const [bgKey, setBgKey] = useState("night");
  const [inputVal, setInputVal] = useState("");
  const [chatLog, setChatLog] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const lipSyncRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatLog]);

  const simulateSpeech = (id, text = null) => {
    if (activeId !== id) {
      setActiveId(id);
      setChatLog([]); // clear log on switch
    }
    const msg = text || `I am ${id.toUpperCase()}. Awaiting your input.`;
    speak(msg,
      () => {
        clearInterval(lipSyncRef.current);
        lipSyncRef.current = setInterval(() => {
          setTalkingStates(prev => ({ ...prev, [id]: Math.random() > 0.3 }));
        }, 120);
      },
      () => {
        clearInterval(lipSyncRef.current);
        setTalkingStates(prev => ({ ...prev, [id]: false }));
      }
    );
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!inputVal.trim()) return;
    const userMsg = inputVal;
    setInputVal("");
    setChatLog(prev => [...prev, { role: "user", text: userMsg }]);
    setIsTyping(true);

    const ag = AGENTS.find(a => a.id === activeId);
    try {
      // Simulate unique prompts based on the selected avatar
      let promptSys = `You are the ${ag.label} agent in NEMESIS. Role: ${ag.role}.
Student "${session?.name || "Operative"}" is talking to you directly.
Keep responses under 30 words. Be in character.`;

      const aiReply = await mistral(promptSys, userMsg, 150);

      setChatLog(prev => [...prev, { role: "ai", text: aiReply }]);
      simulateSpeech(activeId, aiReply);
    } catch {
      setChatLog(prev => [...prev, { role: "ai", text: "Commlink error. Retry." }]);
    }
    setIsTyping(false);
  };

  useEffect(() => {
    return () => { clearInterval(lipSyncRef.current); window.speechSynthesis.cancel(); };
  }, []);

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflow: "hidden" }}>
      {/* Background Layer */}
      {BGS[bgKey]()}

      {/* Content Layer */}
      <div style={{ position: "relative", zIndex: 1, padding: "28px 24px", height: "100vh", display: "flex", flexDirection: "column" }}>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, maxWidth: 1000, margin: "0 auto", width: "100%", flexShrink: 0, gap: 16 }}>
          <Btn onClick={() => { window.speechSynthesis.cancel(); onBack(); }} v="ghost" sz="sm">← WAR ROOM</Btn>
          <div style={{ display: "flex", gap: 10, background: "rgba(0,0,0,0.7)", padding: 8, borderRadius: 8, backdropFilter: "blur(10px)", flexWrap: "wrap", justifyContent: "center", border: `1px solid ${C.border}` }}>
            {Object.keys(BGS).map(k => (
              <button key={k} onClick={() => setBgKey(k)} style={{
                background: bgKey === k ? C.blue : "rgba(255,255,255,0.05)", color: bgKey === k ? "#fff" : C.textDim,
                border: `1px solid ${bgKey === k ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.1)"}`, padding: "8px 16px", borderRadius: 4,
                fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, cursor: "pointer", textTransform: "uppercase", transition: "all 0.2s"
              }}>{k}</button>
            ))}
          </div>
        </div>

        {/* Avatars Row */}
        <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 30, height: 280, maxWidth: 1000, margin: "0 auto", flexShrink: 0 }}>
          {AGENTS.map(ag => {
            const Face = AvatarFaces[ag.id];
            const isActive = activeId === ag.id;
            const isTalking = talkingStates[ag.id] || false;
            return (
              <div key={ag.id} onClick={() => simulateSpeech(ag.id)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", cursor: "pointer",
                  transform: isActive ? "scale(1.2) translateY(-10px)" : "scale(0.9)",
                  opacity: isActive ? 1 : 0.4,
                  transition: "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
                  animation: !isActive ? "float 6s infinite ease-in-out" : undefined,
                  animationDelay: `${Math.random() * 2}s`
                }}>
                <div style={{
                  position: "relative", padding: 15,
                  filter: isActive ? `drop-shadow(0 0 40px ${ag.color}60)` : "blur(1px) brightness(0.7)",
                  transition: "all 0.4s"
                }}>
                  <Face talking={isTalking} />
                </div>
                <div style={{
                  marginTop: 15, textAlign: "center",
                  opacity: isActive ? 1 : 0, transition: "opacity 0.3s",
                  transform: isActive ? "translateY(0)" : "translateY(10px)",
                  background: "rgba(0,0,0,0.6)", padding: "4px 8px", borderRadius: 4, backdropFilter: "blur(4px)"
                }}>
                  <Mono s={12} c={ag.color} style={{ letterSpacing: "3px", textShadow: `0 0 10px ${ag.color}66` }}>{ag.label}</Mono>
                </div>
              </div>
            );
          })}
        </div>

        {/* Chat Interface for Active Avatar */}
        <div style={{ flexGrow: 1, maxWidth: 600, margin: "20px auto 0", width: "100%", display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <Mono s={10} c={AGENTS.find(a => a.id === activeId)?.color} style={{ letterSpacing: "2px", background: "rgba(0,0,0,0.6)", padding: "4px 12px", borderRadius: 12, display: "inline-block" }}>
              DIRECT LINK: {AGENTS.find(a => a.id === activeId)?.role.toUpperCase()}
            </Mono>
          </div>

          <div style={{ flexGrow: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16, padding: "0 10px 20px" }} className="hide-scroll">
            {chatLog.length === 0 && (
              <div style={{ margin: "auto", textAlign: "center", padding: "30px 20px", background: "rgba(0,0,0,0.6)", borderRadius: 12, border: `1px dashed ${AGENTS.find(a => a.id === activeId)?.color}80`, backdropFilter: "blur(5px)" }}>
                <Mono s={14} c={C.text} style={{ marginBottom: 12, display: "block", letterSpacing: "2px" }}>COMM-LINK ESTABLISHED</Mono>
                <Mono s={11} c={C.textDim} style={{ lineHeight: 1.6 }}>Clique sur le 🎙️ en bas et parle à <strong style={{ color: AGENTS.find(a => a.id === activeId)?.color }}>{AGENTS.find(a => a.id === activeId)?.label}</strong><br />...Ou tape ton message dans la barre texte !</Mono>
              </div>
            )}
            {chatLog.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", animation: "fadeUp 0.3s ease" }}>
                <div style={{
                  background: m.role === "user" ? C.blue : "rgba(0,0,0,0.7)", filter: m.role !== "user" ? "drop-shadow(0 4px 12px rgba(0,0,0,0.5))" : "none",
                  border: m.role !== "user" ? `1px solid ${AGENTS.find(a => a.id === activeId)?.color}40` : "none",
                  padding: "12px 16px", borderRadius: 8, maxWidth: "80%", fontSize: 14, color: C.text, lineHeight: 1.5,
                  borderLeft: m.role !== "user" ? `3px solid ${AGENTS.find(a => a.id === activeId)?.color}` : undefined,
                  backdropFilter: m.role !== "user" ? "blur(10px)" : "none"
                }}>
                  {m.text}
                </div>
              </div>
            ))}
            {isTyping && <div style={{ alignSelf: "flex-start", padding: "12px 16px", background: "rgba(0,0,0,0.7)", borderRadius: 8, borderLeft: `3px solid ${AGENTS.find(a => a.id === activeId)?.color}` }}><Dots /></div>}
            <div ref={chatEndRef} />
          </div>

          <form onSubmit={handleSend} style={{ display: "flex", gap: 8, padding: 12, background: "rgba(0,0,0,0.6)", borderRadius: 12, backdropFilter: "blur(10px)", border: `1px solid ${C.border}` }}>
            <VoiceBtn onResult={(t) => setInputVal(prev => prev + " " + t)} />
            <input type="text" value={inputVal} onChange={e => setInputVal(e.target.value)} placeholder={`Speak to ${activeId.toUpperCase()}...`}
              style={{ flexGrow: 1, background: "transparent", border: "none", color: C.text, fontSize: 14, outline: "none" }} />
            <Btn type="submit" sz="sm" v="blue" disabled={isTyping}>SEND</Btn>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: WELCOME
// ─────────────────────────────────────────────
function WelcomeScreen({ onStart }) {
  const [name, setName] = useState("");
  const [courses, setCourses] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const handleFileUpload = async (e) => {
    console.log("Files selected:", e.target.files);
    const uploadedFiles = Array.from(e.target.files);
    for (const file of uploadedFiles) {
      try {
        console.log("Processing file:", file.name, file.type);
        if (file.type === "application/pdf") {
          const text = await extractTextFromPDF(file);
          console.log("Extracted PDF text length:", text.length);
          setFiles(prev => [...prev, { name: file.name, text }]);
        } else if (file.type === "text/plain" || file.name.endsWith(".txt")) {
          const text = await file.text();
          console.log("Extracted TXT text length:", text.length);
          setFiles(prev => [...prev, { name: file.name, text }]);
        } else {
          console.warn("Unsupported file type:", file.type);
        }
      } catch (err) {
        console.error("Error processing file:", file.name, err);
        alert(`Error processing ${file.name}: ${err.message}`);
      }
    }
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const start = async () => {
    if (!courses.trim() && files.length === 0) return;
    setLoading(true);
    setStatus("Shadow Agent initializing threat assessment...");
    await new Promise(r => setTimeout(r, 600));
    setStatus("Mapping vulnerability topology...");

    const materialContext = files.length > 0
      ? `\n\nATTACHED MATERIALS:\n${files.map(f => `--- FILE: ${f.name} ---\n${f.text}`).join("\n\n")}`
      : "";

    const data = await mistralJSON(P.SHADOW, `Student: ${name || "Operative"}. Courses and topics: ${courses}${materialContext}`, 2000);
    setStatus("Building knowledge graph...");
    await new Promise(r => setTimeout(r, 400));
    onStart({ name: name || "OPERATIVE", rawCourses: courses, topics: data?.topics || [], shadowAssessment: data?.assessment || "" });
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px", background: `radial-gradient(ellipse at 50% -10%, rgba(217,64,64,0.07) 0%, ${C.bg} 55%)` }}>
      {/* Scanline */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 9999 }}>
        <div style={{ position: "absolute", left: 0, right: 0, height: "1px", background: "rgba(217,64,64,0.04)", animation: "scanline 10s linear infinite" }} />
      </div>

      <div style={{ textAlign: "center", marginBottom: 56, animation: "fadeUp 0.8s ease" }}>
        <Mono s={10} c={C.red} style={{ letterSpacing: "6px", display: "block", marginBottom: 12 }}>
          ATLAS TBS HACKATHON // MULTI-AGENT AI SYSTEM
        </Mono>
        <h1 style={{
          fontFamily: "'Bebas Neue',sans-serif",
          fontSize: "clamp(80px, 16vw, 150px)", lineHeight: 0.88, letterSpacing: "6px",
          background: `linear-gradient(150deg, ${C.text} 0%, ${C.red} 55%, #6b0f0f 100%)`,
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          filter: `drop-shadow(0 0 50px rgba(217,64,64,0.25))`,
        }}>NEMESIS</h1>
        <p style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: C.textDim, marginTop: 16, letterSpacing: "0.5px", lineHeight: 1.8 }}>
          It doesn't just help you study.<br />
          <span style={{ color: C.red }}>It studies you. Then it hunts your weaknesses.</span>
        </p>
      </div>

      <div style={{ width: "100%", maxWidth: 480, animation: "fadeUp 0.8s ease 0.2s both" }}>
        <Card style={{ padding: 36 }}>
          <Label>OPERATIVE BRIEFING</Label>
          <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px", display: "block", marginBottom: 8 }}>CODENAME (optional)</Mono>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Your name..."
                style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, color: C.text, padding: "11px 14px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, outline: "none" }} />
            </div>
            <div>
              <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px", display: "block", marginBottom: 8 }}>YOUR COURSES & TOPICS *</Mono>
              <textarea value={courses} onChange={e => setCourses(e.target.value)}
                placeholder="e.g. Corporate Finance, Thermodynamics, Marketing Strategy, Contract Law, Statistics, Microeconomics..."
                rows={4}
                style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, color: C.text, padding: "11px 14px", fontSize: 13, outline: "none", resize: "vertical" }} />
            </div>
            <div>
              <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px", display: "block", marginBottom: 8 }}>STUDY MATERIALS (PDF/TXT)</Mono>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                  background: C.surfaceHigh, border: `1px dashed ${C.border}`, color: C.textMid,
                  padding: "16px", cursor: "pointer", transition: "all 0.2s"
                }}>
                  <input type="file" multiple accept=".pdf,.txt" onChange={handleFileUpload} style={{ display: "none" }} />
                  <Mono s={10}>+ UPLOAD MATERIALS</Mono>
                </label>
                {files.map((f, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.surfaceUp, padding: "8px 12px", border: `1px solid ${C.border}` }}>
                    <Mono s={10} c={C.text}>{f.name}</Mono>
                    <button onClick={() => removeFile(i)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>[X]</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 28, display: "flex", gap: 12, alignItems: "center" }}>
            <Btn onClick={start} loading={loading} disabled={!courses.trim() && files.length === 0} sz="lg">
              {loading ? "ANALYZING" : "DEPLOY NEMESIS"}
            </Btn>
            {loading && <Mono s={10} c={C.textDim}>{status}</Mono>}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 48, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, maxWidth: 480, animation: "fadeUp 0.8s ease 0.4s both" }}>
        {[
          { agent: "SHADOW", desc: "Maps weaknesses", icon: "◈" },
          { agent: "NEMESIS", desc: "Attacks blind spots", icon: "⚔" },
          { agent: "SOCRATES", desc: "Forces insight", icon: "∞" },
          { agent: "COACH", desc: "Reads your state", icon: "◎" },
        ].map(a => (
          <div key={a.agent} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, color: C.red, marginBottom: 4 }}>{a.icon}</div>
            <Mono s={10} c={C.text} style={{ display: "block", letterSpacing: "2px" }}>{a.agent}</Mono>
            <Mono s={9} c={C.textDim} style={{ display: "block", marginTop: 2 }}>{a.desc}</Mono>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: WAR ROOM DASHBOARD
// ─────────────────────────────────────────────
// --- POMODORO TIMER FOR ADHD FOCUS ---
function PomodoroTimer({ onComplete }) {
  const [timeLeft, setTimeLeft] = useState(25 * 60); // 25 minutes
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    let interval = null;
    if (isActive && timeLeft > 0) {
      interval = setInterval(() => {
        setTimeLeft(timeLeft - 1);
      }, 1000);
    } else if (timeLeft === 0) {
      setIsActive(false);
      speak("Focus session complete. Great job, operative. Take a 5 minute break.", null, null);
      onComplete && onComplete();
    }
    return () => clearInterval(interval);
  }, [isActive, timeLeft, onComplete]);

  const toggle = () => setIsActive(!isActive);
  const reset = () => { setIsActive(false); setTimeLeft(25 * 60); };
  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, background: "rgba(0,0,0,0.9)", border: `1px dashed ${C.green}50`, padding: "30px 40px", borderRadius: 12, boxShadow: `0 0 40px ${C.green}10` }}>
      <Mono s={14} c={C.green} style={{ letterSpacing: "4px" }}>HYPER FOCUS LINK ESTABLISHED</Mono>
      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 60, fontWeight: "bold", color: isActive ? C.green : C.text, textShadow: isActive ? `0 0 20px ${C.green}80` : "none" }}>
        {mins.toString().padStart(2, '0')}:{secs.toString().padStart(2, '0')}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <Btn onClick={toggle} v={isActive ? "ghost" : "green"} sz="md">{isActive ? "PAUSE CALIBRATION" : "INITIATE FOCUS SEQUENCE"}</Btn>
        <Btn onClick={reset} v="ghost" sz="md">ABORT</Btn>
      </div>
    </div>
  );
}

function WarRoomScreen({ session, dispatch, onGoBattle, onGoSocrates, onGoExam, onGoSpeedRun, onGoIntel, onGoAvatars }) {
  const [adhdMode, setAdhdMode] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(session.topics[0]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("map");
  const [examDate, setExamDate] = useState(() => localStorage.getItem("nemesis_exam") || "");
  const [studyPlan, setStudyPlan] = useState("");
  const [planLoading, setPlanLoading] = useState(false);

  const daysLeft = examDate ? Math.max(0, Math.ceil((new Date(examDate) - Date.now()) / 86400000)) : null;

  const generatePlan = async () => {
    if (!examDate) return;
    setPlanLoading(true);
    const topicList = [...session.topics].sort((a, b) => getUrgency(b) - getUrgency(a)).map(t => `${t.name} (vuln:${t.vulnerability}/10)`).join(", ");
    const numDays = Math.min(daysLeft || 7, 7);
    const plan = await mistralJSON(
      `You are a study planning expert. Return a JSON array of study sessions.
Each object: {"day":number, "topic":string, "focus":string (max 8 words), "duration":string (e.g. "2h"), "priority":"high"|"medium"|"low"}.
Create exactly ${numDays} entries, one per day. Prioritize high-vulnerability topics first.`,
      `Exam in ${daysLeft} days. Topics by urgency: ${topicList}.`, 800
    );
    setStudyPlan(Array.isArray(plan) ? plan : []);
    setPlanLoading(false);
  };

  const handleExamDate = (d) => { setExamDate(d); localStorage.setItem("nemesis_exam", d); };

  const sortedByUrgency = [...session.topics].sort((a, b) => getUrgency(b) - getUrgency(a));
  const totalCorrect = session.history.filter(h => h.correct).length;
  const accuracy = session.history.length ? Math.round((totalCorrect / session.history.length) * 100) : 0;
  const avgVuln = session.topics.length ? Math.round(session.topics.reduce((s, t) => s + t.vulnerability, 0) / session.topics.length) : 0;

  // Orchestrator chat
  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const msg = chatInput; setChatInput(""); setChatLoading(true);
    dispatch({ type: "CHAT", msg: { role: "user", text: msg, ts: Date.now() } });

    const topicsSummary = session.topics.map(t => `${t.id}:${t.name}(vuln:${t.vulnerability})`).join(", ");
    const histSummary = `Answered ${session.history.length} questions. Accuracy: ${accuracy}%. XP: ${session.totalXP}.`;
    const routing = await mistralJSON(P.ORCHESTRATOR,
      `Student ${session.name}: "${msg}"\nSession: ${histSummary}\nTopics: ${topicsSummary}\nMost urgent: ${sortedByUrgency[0]?.name}`
    );

    if (!routing) { setChatLoading(false); return; }

    dispatch({ type: "CHAT", msg: { role: "orchestrator", routing, text: routing.reasoning, coachNote: routing.coachNote, ts: Date.now() } });

    // Auto-route
    const target = session.topics.find(t => t.id === routing.topicId) || sortedByUrgency[0];
    setTimeout(() => {
      if (routing.agent === "nemesis" || routing.agent === "review") onGoBattle(target, routing.agent);
      else if (routing.agent === "socrates") onGoSocrates(target);
      else if (routing.agent === "exam") onGoExam();
      else if (routing.agent === "coach") {
        // Coach response inline
        mistralJSON(P.COACH, `Student "${session.name}" says: "${msg}". State from orchestrator: ${routing.coachNote || "general"}`).then(cr => {
          if (cr) {
            dispatch({ type: "CHAT", msg: { role: "coach", text: cr.message, observation: cr.observation, state: cr.state, ts: Date.now() } });
            speak(cr.message, null, null);
          }
        });
      }
    }, 600);
    setChatLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: "24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 40, letterSpacing: "4px", lineHeight: 1 }}>
            NEMESIS <span style={{ color: C.red }}>//</span> WAR ROOM
          </h1>
          <Mono s={10} c={C.textDim} style={{ letterSpacing: "2px" }}>
            {session.name?.toUpperCase()} — {session.topics.length} VULNERABILITIES — {session.totalXP} XP
          </Mono>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* ADHD Toggle */}
          <button onClick={() => setAdhdMode(!adhdMode)} style={{
            background: adhdMode ? C.green : "transparent", color: adhdMode ? "#000" : C.textDim,
            border: `1px solid ${adhdMode ? C.green : C.border}`, padding: "6px 12px", borderRadius: 4,
            fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, cursor: "pointer", textTransform: "uppercase", transition: "all 0.2s"
          }}>
            {adhdMode ? "👁️ SENSORY OVERRIDE ON" : "👁️ ADHD FOCUS OFF"}
          </button>
          {/* Exam Countdown */}
          {!adhdMode && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", background: C.surface, border: `1px solid ${daysLeft !== null && daysLeft <= 3 ? C.red : C.border}`, padding: "6px 12px" }}>
              <Mono s={9} c={C.textDim}>📅 EXAM:</Mono>
              <input type="date" value={examDate} onChange={e => handleExamDate(e.target.value)}
                style={{ background: "transparent", border: "none", color: daysLeft !== null && daysLeft <= 3 ? C.red : C.text, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, outline: "none", cursor: "pointer" }}
              />
              {daysLeft !== null && <Mono s={10} c={daysLeft <= 3 ? C.red : daysLeft <= 7 ? C.amber : C.green} style={{ letterSpacing: "1px" }}>{daysLeft}d left</Mono>}
            </div>
          )}
          {!adhdMode && <Btn onClick={onGoAvatars} v="ghost" sz="sm">👤 AVATARS</Btn>}
          {!adhdMode && <Btn onClick={onGoExam} v="amber" sz="sm">⬡ EXAM MODE</Btn>}
          {!adhdMode && <DefconMeter avgVuln={avgVuln} />}
        </div>
      </div>

      {adhdMode && (
        <div style={{ marginBottom: 40, display: "flex", justifyContent: "center", animation: "fadeUp 0.4s ease" }}>
          <PomodoroTimer />
        </div>
      )}

      {/* Quick stats */}
      {!adhdMode && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
          {[
            { label: "ACCURACY", value: `${accuracy}%`, color: accuracy < 50 ? C.red : accuracy < 75 ? C.amber : C.green },
            { label: "QUESTIONS", value: session.history.length, color: C.text },
            { label: "TOTAL XP", value: session.totalXP, color: C.amberLight },
            { label: "AVG VULNERABILITY", value: `${avgVuln}/10`, color: avgVuln > 6 ? C.red : avgVuln > 3 ? C.amber : C.green },
          ].map(s => (
            <Card key={s.label} style={{ padding: "14px 16px", textAlign: "center" }}>
              <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 30, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <Mono s={8} c={C.textDim} style={{ display: "block", marginTop: 3, letterSpacing: "2px" }}>{s.label}</Mono>
            </Card>
          ))}
          <ReadinessScore session={session} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16 }}>
        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Tab bar */}
          <div style={{ display: "flex", gap: 2, background: C.surface, padding: 4, border: `1px solid ${C.border}` }}>
            {["map", "topics", "progress"].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                flex: 1, padding: "8px 0", fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase",
                background: activeTab === tab ? C.surfaceHigh : "transparent",
                color: activeTab === tab ? C.text : C.textDim,
                border: activeTab === tab ? `1px solid ${C.border}` : "1px solid transparent",
                cursor: "pointer",
              }}>{tab}</button>
            ))}
          </div>

          {/* Map tab */}
          {activeTab === "map" && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <Label>VULNERABILITY MAP</Label>
                <div style={{ display: "flex", gap: 12 }}>
                  {[{ c: C.red, l: "HIGH" }, { c: C.amber, l: "MED" }, { c: C.green, l: "LOW" }].map(x => (
                    <div key={x.l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: x.c }} />
                      <Mono s={8} c={C.textDim}>{x.l}</Mono>
                    </div>
                  ))}
                </div>
              </div>
              <KnowledgeGraph topics={session.topics} selectedId={selectedTopic?.id} onSelect={setSelectedTopic} />
              <Mono s={9} c={C.textDim} style={{ display: "block", textAlign: "center", marginTop: 8 }}>
                Click a node to select topic — ring shows memory retention
              </Mono>
            </Card>
          )}

          {/* Topics tab */}
          {activeTab === "topics" && (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
                <Label>PRIORITY QUEUE — SORTED BY URGENCY</Label>
              </div>
              <div style={{ maxHeight: 340, overflowY: "auto" }}>
                {sortedByUrgency.map((t, i) => {
                  const urg = getUrgency(t);
                  const ret = getRetention(t);
                  return (
                    <div key={t.id} onClick={() => { setSelectedTopic(t); setActiveTab("map"); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 14, padding: "12px 18px",
                        borderBottom: `1px solid ${C.border}`, cursor: "pointer",
                        background: selectedTopic?.id === t.id ? C.surfaceHigh : "transparent",
                        transition: "background 0.15s",
                      }}>
                      <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 18, color: C.textFaint, width: 16 }}>{i + 1}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</div>
                        <Mono s={9} c={C.textDim}>{t.failureMode?.slice(0, 50)}</Mono>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <VulnBar v={t.vulnerability} />
                        <Mono s={8} c={ret < 50 ? C.red : C.textDim} style={{ display: "block", marginTop: 3 }}>
                          {ret}% mem
                        </Mono>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Btn onClick={e => { e.stopPropagation(); onGoBattle(t, "nemesis"); }} sz="sm">⚔</Btn>
                        <Btn onClick={e => { e.stopPropagation(); onGoSocrates(t); }} v="ghost" sz="sm">∞</Btn>
                        <Btn onClick={e => { e.stopPropagation(); onGoIntel(t); }} v="blue" sz="sm">🔍</Btn>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Progress tab */}
          {activeTab === "progress" && (
            <Card>
              <Label>PERFORMANCE HISTORY</Label>
              <div style={{ marginTop: 16 }}>
                {session.history.length === 0 ? (
                  <Mono s={11} c={C.textDim}>No answers recorded yet. Start a battle.</Mono>
                ) : (
                  <div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 16 }}>
                      {session.history.slice(-50).map((h, i) => (
                        <div key={i} style={{ width: 12, height: 12, background: h.correct ? C.green : C.red, opacity: 0.8 }} title={`Q${i + 1}: ${h.correct ? "✓" : "✗"}`} />
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      {session.topics.filter(t => session.history.some(h => h.topicId === t.id)).map(t => {
                        const th = session.history.filter(h => h.topicId === t.id);
                        const acc = Math.round(th.filter(h => h.correct).length / th.length * 100);
                        return (
                          <div key={t.id} style={{ background: C.surfaceHigh, padding: "10px 12px" }}>
                            <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ flex: 1, height: 3, background: C.border, borderRadius: 2 }}>
                                <div style={{ width: `${acc}%`, height: "100%", background: acc > 70 ? C.green : acc > 40 ? C.amber : C.red, borderRadius: 2 }} />
                              </div>
                              <Mono s={9} c={C.textDim}>{acc}%</Mono>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Selected topic detail */}
          {selectedTopic && activeTab === "map" && (
            <Card hot>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <Label>SELECTED TARGET</Label>
                  <h2 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 30, letterSpacing: "2px", marginTop: 8 }}>{selectedTopic.name}</h2>
                  <Mono s={9} c={C.textDim}>{selectedTopic.category}</Mono>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={() => onGoBattle(selectedTopic, "nemesis")}>⚔ ATTACK</Btn>
                  <Btn onClick={() => onGoSocrates(selectedTopic)} v="ghost">∞ SOCRATES</Btn>
                  <Btn onClick={() => onGoBattle(selectedTopic, "review")} v="amber">↻ REVIEW</Btn>
                  <Btn onClick={() => onGoIntel(selectedTopic)} v="blue">🔍 INTEL</Btn>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
                {[
                  { l: "DIFFICULTY", v: selectedTopic.difficulty, c: C.text },
                  { l: "VULNERABILITY", v: selectedTopic.vulnerability, c: selectedTopic.vulnerability > 6 ? C.red : C.amber },
                  { l: "EXAM WEIGHT", v: selectedTopic.examWeight, c: C.amberLight },
                  { l: "URGENCY", v: getUrgency(selectedTopic), c: C.red },
                ].map(m => (
                  <div key={m.l} style={{ background: C.surfaceHigh, padding: "10px", textAlign: "center" }}>
                    <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 26, color: m.c, lineHeight: 1 }}>{m.v}</div>
                    <Mono s={7} c={C.textDim} style={{ display: "block", marginTop: 3, letterSpacing: "1.5px" }}>{m.l}</Mono>
                  </div>
                ))}
              </div>
              <ForgettingCurve topic={selectedTopic} />
              {selectedTopic.failureMode && (
                <div style={{ marginTop: 12, padding: "8px 12px", background: "rgba(217,64,64,0.06)", borderLeft: `2px solid ${C.red}` }}>
                  <Mono s={9} c={C.red} style={{ letterSpacing: "1px" }}>FAILURE MODE: </Mono>
                  <Mono s={10} c={C.textMid}>{selectedTopic.failureMode}</Mono>
                </div>
              )}
            </Card>
          )}
        </div>

        {/* Right column: Orchestrator Chat */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 520 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <Label color={C.amberLight}>◈ ORCHESTRATOR</Label>
              <Mono s={9} c={C.textDim}>Natural language routing</Mono>
            </div>
            <Mono s={9} c={C.textDim} style={{ display: "block", marginBottom: 12, lineHeight: 1.6 }}>
              Tell the Orchestrator how you feel or what you want — it will route you to the right agent automatically.
            </Mono>

            {/* Chat log */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, marginBottom: 12, maxHeight: 340 }}>
              {session.chatLog.length === 0 && (
                <div style={{ padding: "20px 0", textAlign: "center" }}>
                  <Mono s={20} c={C.textFaint} style={{ display: "block", marginBottom: 8 }}>◈</Mono>
                  <Mono s={10} c={C.textFaint}>No conversations yet.<br />Tell me your situation.</Mono>
                </div>
              )}
              {session.chatLog.map((m, i) => (
                <div key={i} style={{ animation: "fadeUp 0.3s ease" }}>
                  {m.role === "user" && (
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <div style={{ maxWidth: "80%", padding: "10px 14px", background: C.surfaceHigh, border: `1px solid ${C.border}`, fontSize: 13, lineHeight: 1.5 }}>
                        {m.text}
                      </div>
                    </div>
                  )}
                  {m.role === "orchestrator" && (
                    <div style={{ padding: "10px 14px", background: "rgba(217,64,64,0.06)", border: `1px solid ${C.border}` }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                        <Mono s={8} c={C.red} style={{ letterSpacing: "2px" }}>ORCHESTRATOR → {m.routing?.agent?.toUpperCase()}</Mono>
                        <Label color={m.routing?.urgency === "high" ? C.red : C.amber}>{m.routing?.urgency}</Label>
                      </div>
                      <Mono s={10} c={C.textMid} style={{ display: "block", lineHeight: 1.5 }}>{m.text}</Mono>
                      {m.coachNote && <Mono s={9} c={C.amberLight} style={{ display: "block", marginTop: 4, fontStyle: "italic" }}>"{m.coachNote}"</Mono>}
                      <Mono s={9} c={C.textDim} style={{ display: "block", marginTop: 4 }}>↗ Routing to {m.routing?.agent}...</Mono>
                    </div>
                  )}
                  {m.role === "coach" && (
                    <div style={{ padding: "10px 14px", background: "rgba(42,127,212,0.06)", border: `1px solid rgba(42,127,212,0.2)` }}>
                      <Mono s={8} c={C.blueLight} style={{ display: "block", letterSpacing: "2px", marginBottom: 5 }}>COACH // {m.state?.toUpperCase()}</Mono>
                      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, fontStyle: "italic" }}>{m.text}</div>
                      {m.observation && <Mono s={9} c={C.amber} style={{ display: "block", marginTop: 6 }}>⚡ {m.observation}</Mono>}
                    </div>
                  )}
                </div>
              ))}
              {chatLoading && (
                <div style={{ padding: "10px 14px", background: "rgba(217,64,64,0.04)", border: `1px solid ${C.border}` }}>
                  <Mono s={9} c={C.red} style={{ letterSpacing: "2px" }}>ORCHESTRATOR ROUTING</Mono>
                  <div style={{ marginTop: 4 }}><Dots /></div>
                </div>
              )}
            </div>

            {/* Input */}
            <div style={{ display: "flex", gap: 8 }}>
              <textarea value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendChat())}
                placeholder="I'm struggling with thermodynamics... / Challenge me on finance / I'm tired..."
                rows={2}
                style={{ flex: 1, background: C.surfaceHigh, border: `1px solid ${C.border}`, color: C.text, padding: "10px 12px", fontSize: 13, outline: "none", resize: "none" }}
              />
              <VoiceBtn onResult={text => { setChatInput(text); }} />
              <Btn onClick={sendChat} loading={chatLoading} sz="sm">↗</Btn>
            </div>
          </Card>

          {/* Quick action buttons */}
          <Card>
            <Label>QUICK ACTIONS</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              <Btn onClick={() => onGoBattle(sortedByUrgency[0], "nemesis")} style={{ width: "100%", justifyContent: "center" }}>
                ⚔ ATTACK MOST VULNERABLE — {sortedByUrgency[0]?.name?.slice(0, 20)}
              </Btn>
              <Btn onClick={onGoExam} v="amber" style={{ width: "100%", justifyContent: "center" }}>
                ⬡ FULL EXAM SIMULATION
              </Btn>
              <Btn onClick={() => onGoBattle(sortedByUrgency.find(t => getRetention(t) < 70) || sortedByUrgency[0], "review")} v="success" style={{ width: "100%", justifyContent: "center" }}>
                ↻ SPACED REPETITION REVIEW
              </Btn>
              <Btn onClick={onGoSpeedRun} v="blue" style={{ width: "100%", justifyContent: "center" }}>
                ⚡ SPEED RUN — 60s BLITZ
              </Btn>
            </div>
          </Card>

          {/* Study Plan Card */}
          {examDate && (
            <Card style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <Label color={C.blueLight}>📊 AI STUDY PLAN — {daysLeft}d UNTIL EXAM</Label>
                <Btn onClick={generatePlan} loading={planLoading} v="blue" sz="sm">GENERATE</Btn>
              </div>
              {Array.isArray(studyPlan) && studyPlan.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["DAY", "TOPIC", "FOCUS", "DURATION", "PRIORITY"].map(h => (
                          <th key={h} style={{ padding: "6px 10px", color: C.textDim, letterSpacing: "2px", textAlign: "left", fontWeight: 400 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {studyPlan.map((row, i) => {
                        const pc = row.priority === "high" ? C.red : row.priority === "medium" ? C.amber : C.green;
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.border}20`, background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                            <td style={{ padding: "8px 10px", color: C.textDim, fontFamily: "'Bebas Neue',sans-serif", fontSize: 18, lineHeight: 1 }}>D{row.day}</td>
                            <td style={{ padding: "8px 10px", color: C.text, fontWeight: 500 }}>{row.topic}</td>
                            <td style={{ padding: "8px 10px", color: C.textMid }}>{row.focus}</td>
                            <td style={{ padding: "8px 10px", color: C.amberLight }}>{row.duration}</td>
                            <td style={{ padding: "8px 10px" }}>
                              <span style={{ color: pc, border: `1px solid ${pc}`, padding: "2px 6px", fontSize: 8, letterSpacing: "2px", textTransform: "uppercase" }}>{row.priority}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Mono s={10} c={C.textDim}>Click GENERATE to get your personalized {Math.min(daysLeft || 7, 7)}-day plan.</Mono>
              )}
            </Card>
          )}

          {/* Shadow assessment */}
          {session.shadowAssessment && (
            <Card>
              <Label color={C.textDim}>SHADOW AGENT ASSESSMENT</Label>
              <p style={{ fontSize: 12, color: C.textMid, lineHeight: 1.7, marginTop: 10, fontStyle: "italic" }}>
                "{session.shadowAssessment}"
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: BATTLE MODE (NEMESIS + REVIEW)
// ─────────────────────────────────────────────
function BattleScreen({ topic, mode, session, dispatch, onBack }) {
  const [q, setQ] = useState(null);
  const [selected, setSelected] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [qCount, setQCount] = useState(0);
  const [socInput, setSocInput] = useState("");
  const [socReply, setSocReply] = useState("");
  const [socLoading, setSocLoading] = useState(false);

  const topicHistory = session.history.filter(h => h.topicId === topic.id);
  const topicAcc = topicHistory.length ? Math.round(topicHistory.filter(h => h.correct).length / topicHistory.length * 100) : null;

  const fetchQ = useCallback(async () => {
    setLoading(true); setSelected(null); setRevealed(false); setSocReply(""); setSocInput("");
    const prompt = mode === "review" ? P.REVIEW : P.NEMESIS;
    const ctx = `Topic: ${topic.name}. Failure mode: ${topic.failureMode || "general"}. Vulnerability: ${topic.vulnerability}/10. Difficulty requested: ${mode === "review" ? "easy-medium" : "hard"}. Course context: ${session.rawCourses}`;
    const data = await mistralJSON(prompt, ctx);
    setQ(data); setQCount(c => c + 1); setLoading(false);
  }, [topic, mode, session]);

  useEffect(() => { fetchQ(); }, []);

  const answer = (opt) => {
    if (revealed) return;
    setSelected(opt);
    setRevealed(true);
    dispatch({ type: "RECORD", topicId: topic.id, correct: opt === q.correct, difficulty: q.difficulty || 5 });
  };

  const askSocrates = async () => {
    if (!socInput.trim()) return;
    setSocLoading(true);
    const r = await mistral(P.SOCRATES, `Topic: ${topic.name}. Question was: ${q?.question}. Student says: "${socInput}"`);
    setSocReply(r); setSocLoading(false);
  };

  const optBg = (opt) => {
    if (!revealed) return selected === opt ? C.surfaceHigh : "transparent";
    if (opt === q.correct) return "rgba(42,157,92,0.12)";
    if (opt === selected && opt !== q.correct) return "rgba(217,64,64,0.1)";
    return "transparent";
  };
  const optBorder = (opt) => {
    if (!revealed) return C.border;
    if (opt === q.correct) return C.green;
    if (opt === selected && opt !== q.correct) return C.red;
    return C.border;
  };

  const sessionCorrect = session.history.filter(h => h.topicId === topic.id && h.correct).length;
  const sessionTotal = session.history.filter(h => h.topicId === topic.id).length;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: "28px 24px", maxWidth: 760, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Btn onClick={onBack} v="ghost" sz="sm">← RETREAT</Btn>
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <h2 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 26, letterSpacing: "3px" }}>
                {mode === "review" ? "↻ REVIEW MODE" : "⚔ NEMESIS ATTACKING"}
              </h2>
              <Label color={mode === "review" ? C.green : C.red}>{mode?.toUpperCase()}</Label>
            </div>
            <Mono s={9} c={C.textDim}>TARGET: {topic.name?.toUpperCase()} — VULN {topic.vulnerability}/10</Mono>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 30, color: sessionCorrect / sessionTotal > 0.6 ? C.green : C.red, lineHeight: 1 }}>
            {sessionCorrect}/{Math.max(sessionTotal, qCount)}
          </div>
          <Mono s={8} c={C.textDim} style={{ letterSpacing: "2px" }}>SESSION SCORE</Mono>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "80px 0" }}>
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, color: C.red, letterSpacing: "4px" }}>
            {mode === "nemesis" ? "NEMESIS BUILDING ATTACK" : "GENERATING REVIEW"}<Dots />
          </div>
          <Mono s={10} c={C.textDim} style={{ display: "block", marginTop: 8 }}>
            {mode === "nemesis" ? "Scanning failure mode vector..." : "Selecting optimal review material..."}
          </Mono>
        </div>
      ) : q ? (
        <div style={{ animation: "fadeUp 0.4s ease" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Label color={q.difficulty > 7 ? C.red : q.difficulty > 4 ? C.amber : C.green}>DIFFICULTY {q.difficulty}/10</Label>
            <Label color={C.textDim}>{q.concept}</Label>
            <Mono s={9} c={C.textDim}>Q{qCount}</Mono>
          </div>

          <Card hot={mode === "nemesis"} style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 16, lineHeight: 1.75, color: C.text }}>{q.question}</p>
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {["A", "B", "C", "D"].map(opt => (
              <div key={opt} onClick={() => answer(opt)} style={{
                display: "flex", gap: 14, alignItems: "flex-start", padding: "14px 18px",
                background: optBg(opt), border: `1px solid ${optBorder(opt)}`,
                cursor: revealed ? "default" : "pointer", transition: "all 0.15s",
                animation: revealed && opt === selected && opt !== q.correct ? "shake 0.3s ease" : undefined,
              }}>
                <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 20, color: !revealed ? C.red : opt === q.correct ? C.green : opt === selected ? C.red : C.textFaint, width: 18, flexShrink: 0 }}>{opt}</div>
                <div style={{ flex: 1, fontSize: 14, lineHeight: 1.55, color: C.text }}>{q.options?.[opt]}</div>
                {revealed && opt === q.correct && <span style={{ color: C.green, fontSize: 18, marginLeft: "auto" }}>✓</span>}
                {revealed && opt === selected && opt !== q.correct && <span style={{ color: C.red, fontSize: 18, marginLeft: "auto" }}>✗</span>}
              </div>
            ))}
          </div>

          {revealed && (
            <div style={{ animation: "fadeUp 0.4s ease" }}>
              {q.trap && mode === "nemesis" && (
                <Card style={{ marginBottom: 14, borderLeft: `3px solid ${C.red}`, padding: "14px 18px" }}>
                  <Mono s={9} c={C.red} style={{ letterSpacing: "2px", display: "block", marginBottom: 6 }}>⚔ NEMESIS DEBRIEFING — THE TRAP</Mono>
                  <p style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{q.trap}</p>
                </Card>
              )}
              {q.explanation && (
                <Card style={{ marginBottom: 14, borderLeft: `3px solid ${C.green}`, padding: "14px 18px" }}>
                  <Mono s={9} c={C.green} style={{ letterSpacing: "2px", display: "block", marginBottom: 6 }}>✓ EXPLANATION</Mono>
                  <p style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{q.explanation}</p>
                </Card>
              )}

              {selected !== q.correct && (
                <Card style={{ marginBottom: 14, borderLeft: `3px solid ${C.blue}`, padding: "14px 18px" }}>
                  <Mono s={9} c={C.blueLight} style={{ letterSpacing: "2px", display: "block", marginBottom: 8 }}>∞ ASK SOCRATES WHY</Mono>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input value={socInput} onChange={e => setSocInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && askSocrates()}
                      placeholder="Tell Socrates what confused you..."
                      style={{ flex: 1, background: C.surfaceHigh, border: `1px solid ${C.border}`, color: C.text, padding: "9px 12px", fontSize: 13, outline: "none" }} />
                    <Btn onClick={askSocrates} loading={socLoading} v="blue" sz="sm">ASK</Btn>
                  </div>
                  {socReply && (
                    <div style={{ marginTop: 10, padding: "12px 14px", background: "rgba(42,127,212,0.06)", border: "1px solid rgba(42,127,212,0.15)", fontStyle: "italic", fontSize: 14, color: C.text, lineHeight: 1.7, animation: "fadeUp 0.3s ease" }}>
                      <Mono s={8} c={C.blueLight} style={{ display: "block", letterSpacing: "2px", marginBottom: 5 }}>SOCRATES:</Mono>
                      {socReply}
                    </div>
                  )}
                </Card>
              )}

              <Btn onClick={fetchQ} sz="lg">NEXT {mode === "nemesis" ? "ATTACK" : "REVIEW"} →</Btn>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: SOCRATES DIALOGUE
// ─────────────────────────────────────────────
function SocratesScreen({ topic, session, onBack }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    setMsgs([{ role: "soc", text: `I am Socrates.\n\nYou wish to understand ${topic.name}? Very well. Before I say anything—\n\nWhat do you already think you know about it? Begin there, and be specific.` }]);
  }, [topic]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const txt = input; setInput("");
    setMsgs(m => [...m, { role: "user", text: txt }]);
    setLoading(true);
    const history = msgs.map(m => `${m.role === "user" ? "Student" : "Socrates"}: ${m.text}`).join("\n\n");
    const reply = await mistral(P.SOCRATES, `Topic: ${topic.name}. Failure mode: ${topic.failureMode}.\n\nConversation:\n${history}\n\nStudent: ${txt}`);
    setMsgs(m => [...m, { role: "soc", text: reply }]);
    speak(reply,
      () => { }, // could add lip sync state here if avatars were on this page
      () => { }
    );
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", maxWidth: 700, margin: "0 auto", padding: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <Btn onClick={onBack} v="ghost" sz="sm">← BACK</Btn>
        <div>
          <h2 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 26, letterSpacing: "3px" }}>∞ SOCRATIC DIALOGUE</h2>
          <Mono s={9} c={C.textDim}>{topic.name?.toUpperCase()} — GUIDED UNDERSTANDING MODE</Mono>
        </div>
      </div>

      <Card style={{ marginBottom: 14, padding: "10px 16px" }}>
        <Mono s={10} c={C.textDim} style={{ lineHeight: 1.6 }}>
          Socrates will never give you the answer directly. He will ask questions until you discover it yourself. This is the most effective form of learning.
        </Mono>
      </Card>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, marginBottom: 14, paddingRight: 2 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", animation: "fadeUp 0.3s ease" }}>
            {m.role === "soc" && <Mono s={8} c={C.blueLight} style={{ display: "block", letterSpacing: "2px", marginBottom: 4 }}>SOCRATES</Mono>}
            <div style={{
              padding: "14px 18px", lineHeight: 1.75, fontSize: 14, color: C.text,
              background: m.role === "user" ? C.surfaceHigh : "rgba(42,127,212,0.06)",
              border: `1px solid ${m.role === "user" ? C.border : "rgba(42,127,212,0.2)"}`,
              fontStyle: m.role === "soc" ? "italic" : "normal",
              whiteSpace: "pre-line",
            }}>{m.text}</div>
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: "flex-start" }}>
            <Mono s={8} c={C.blueLight} style={{ display: "block", letterSpacing: "2px", marginBottom: 4 }}>SOCRATES</Mono>
            <div style={{ padding: "14px 18px", background: "rgba(42,127,212,0.06)", border: "1px solid rgba(42,127,212,0.2)" }}><Dots /></div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <textarea value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Respond to Socrates... (Enter to send, Shift+Enter for new line)"
          rows={2}
          style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, color: C.text, padding: "11px 14px", fontSize: 14, outline: "none", resize: "none" }}
        />
        <Btn onClick={send} loading={loading}>SEND</Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: EXAM SIMULATOR
// ─────────────────────────────────────────────
function ExamScreen({ session, dispatch, onBack }) {
  const [phase, setPhase] = useState("intro"); // intro | running | results
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const timerRef = useRef(null);

  const NUM_Q = 8;

  const startExam = async () => {
    setLoading(true); setPhase("building");
    // Pick topics weighted by urgency
    const sorted = [...session.topics].sort((a, b) => getUrgency(b) - getUrgency(a));
    const selected = sorted.slice(0, Math.min(NUM_Q, sorted.length));

    const qs = await Promise.all(selected.map(async (t) => {
      const q = await mistralJSON(P.NEMESIS, `Topic: ${t.name}. Failure mode: ${t.failureMode || ""}. Vulnerability: ${t.vulnerability}/10. Context: ${session.rawCourses}`);
      return q ? { ...q, topicId: t.id, topicName: t.name } : null;
    }));

    const valid = qs.filter(Boolean);
    setQuestions(valid);
    setAnswers({});
    setCurrent(0);
    setTimeLeft(valid.length * 90); // 90s per question
    setPhase("running");
    setLoading(false);
  };

  useEffect(() => {
    if (phase === "running" && timeLeft > 0) {
      timerRef.current = setInterval(() => setTimeLeft(t => {
        if (t <= 1) { clearInterval(timerRef.current); setPhase("results"); return 0; }
        return t - 1;
      }), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [phase]);

  const selectAnswer = (idx, opt) => {
    if (answers[idx] !== undefined) return;
    const newAns = { ...answers, [idx]: opt };
    setAnswers(newAns);
    dispatch({ type: "RECORD", topicId: questions[idx].topicId, correct: opt === questions[idx].correct, difficulty: questions[idx].difficulty || 5 });
    if (idx === questions.length - 1) {
      clearInterval(timerRef.current);
      setTimeout(() => setPhase("results"), 800);
    } else {
      setTimeout(() => setCurrent(idx + 1), 500);
    }
  };

  const score = questions.filter((q, i) => answers[i] === q.correct).length;
  const pct = questions.length ? Math.round((score / questions.length) * 100) : 0;
  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: "28px 24px", maxWidth: 820, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
        <Btn onClick={onBack} v="ghost" sz="sm">← BACK</Btn>
        <div>
          <h2 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 30, letterSpacing: "3px" }}>⬡ EXAM SIMULATOR</h2>
          <Mono s={9} c={C.textDim}>NEMESIS generates questions from your most vulnerable topics</Mono>
        </div>
      </div>

      {phase === "intro" && (
        <Card style={{ maxWidth: 500, animation: "fadeUp 0.4s ease" }}>
          <Label color={C.amber}>EXAM BRIEFING</Label>
          <p style={{ fontSize: 14, color: C.textMid, lineHeight: 1.75, marginTop: 14 }}>
            Nemesis will select your <strong style={{ color: C.red }}>{Math.min(NUM_Q, session.topics.length)} most vulnerable topics</strong> and generate one adversarial question each.
            90 seconds per question. No hints. Full pressure.
          </p>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {[...session.topics].sort((a, b) => getUrgency(b) - getUrgency(a)).slice(0, NUM_Q).map((t, i) => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: C.surfaceHigh }}>
                <span style={{ fontSize: 13 }}>{i + 1}. {t.name}</span>
                <VulnBar v={t.vulnerability} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 20 }}>
            <Btn onClick={startExam} sz="lg">BEGIN EXAM</Btn>
          </div>
        </Card>
      )}

      {phase === "building" && (
        <div style={{ textAlign: "center", padding: "80px 0" }}>
          <Spinner />
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 26, color: C.red, letterSpacing: "4px", marginTop: 16 }}>NEMESIS BUILDING EXAM<Dots /></div>
          <Mono s={10} c={C.textDim} style={{ display: "block", marginTop: 8 }}>Generating adversarial questions...</Mono>
        </div>
      )}

      {phase === "running" && questions[current] && (
        <div style={{ animation: "fadeUp 0.3s ease" }}>
          {/* Progress + Timer */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <div style={{ flex: 1, height: 3, background: C.surface }}>
              <div style={{ width: `${((current) / questions.length) * 100}%`, height: "100%", background: C.red, transition: "width 0.4s" }} />
            </div>
            <Mono s={12} c={timeLeft < 60 ? C.red : C.textMid}>{mins}:{secs.toString().padStart(2, "0")}</Mono>
            <Mono s={10} c={C.textDim}>{current + 1}/{questions.length}</Mono>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <Label color={questions[current].difficulty > 7 ? C.red : C.amber}>DIFFICULTY {questions[current].difficulty}/10</Label>
            <Label color={C.textDim}>{questions[current].concept}</Label>
            <Label color={C.textDim}>{questions[current].topicName}</Label>
          </div>

          <Card hot style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 16, lineHeight: 1.75 }}>{questions[current].question}</p>
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {["A", "B", "C", "D"].map(opt => {
              const ans = answers[current];
              const bg = !ans ? "transparent" : opt === questions[current].correct ? "rgba(42,157,92,0.12)" : opt === ans ? "rgba(217,64,64,0.1)" : "transparent";
              const border = !ans ? C.border : opt === questions[current].correct ? C.green : opt === ans ? C.red : C.border;
              return (
                <div key={opt} onClick={() => selectAnswer(current, opt)} style={{
                  display: "flex", gap: 14, alignItems: "flex-start", padding: "13px 16px",
                  background: bg, border: `1px solid ${border}`,
                  cursor: ans ? "default" : "pointer", transition: "all 0.2s",
                }}>
                  <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 20, color: !ans ? C.red : opt === questions[current].correct ? C.green : opt === ans ? C.red : C.textFaint, width: 18, flexShrink: 0 }}>{opt}</div>
                  <div style={{ flex: 1, fontSize: 14, lineHeight: 1.5 }}>{questions[current].options?.[opt]}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {phase === "results" && (
        <div style={{ animation: "fadeUp 0.5s ease" }}>
          <Card hot style={{ textAlign: "center", padding: "40px", marginBottom: 20 }}>
            <Mono s={10} c={C.textDim} style={{ letterSpacing: "3px", display: "block", marginBottom: 8 }}>EXAM COMPLETE</Mono>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 96, lineHeight: 0.9, color: pct >= 75 ? C.green : pct >= 50 ? C.amber : C.red }}>
              {pct}%
            </div>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 24, color: C.textMid, marginTop: 8 }}>
              {score} / {questions.length} CORRECT
            </div>
            <p style={{ color: C.textMid, fontSize: 14, marginTop: 14, lineHeight: 1.6 }}>
              {pct >= 80 ? "Excellent performance. Vulnerability scores updated downward." : pct >= 60 ? "Solid result. Some gaps identified." : "Significant vulnerabilities exposed. Focus on red topics."}
            </p>
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {questions.map((q, i) => {
              const correct = answers[i] === q.correct;
              return (
                <Card key={i} style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ fontSize: 18, color: correct ? C.green : C.red, flexShrink: 0 }}>{correct ? "✓" : "✗"}</div>
                    <div style={{ flex: 1 }}>
                      <Label color={C.textDim}>{q.topicName}</Label>
                      <p style={{ fontSize: 13, color: C.textMid, marginTop: 6, lineHeight: 1.5 }}>{q.question}</p>
                      {!correct && q.explanation && (
                        <p style={{ fontSize: 12, color: C.textDim, marginTop: 6, borderLeft: `2px solid ${C.border}`, paddingLeft: 10, lineHeight: 1.5 }}>
                          {q.explanation?.slice(0, 150)}...
                        </p>
                      )}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <Mono s={9} c={C.textDim}>{answers[i] || "–"} / {q.correct}</Mono>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
            <Btn onClick={startExam} sz="lg">RETRY EXAM</Btn>
            <Btn onClick={onBack} v="ghost" sz="lg">← WAR ROOM</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// READINESS SCORE
// ─────────────────────────────────────────────
function ReadinessScore({ session }) {
  const accuracy = session.history.length
    ? session.history.filter(h => h.correct).length / session.history.length
    : 0.5;
  const avgRet = session.topics.length
    ? session.topics.reduce((s, t) => s + getRetention(t), 0) / session.topics.length / 100
    : 0.7;
  const avgVuln = session.topics.length
    ? session.topics.reduce((s, t) => s + t.vulnerability, 0) / session.topics.length
    : 5;
  const vulnF = 1 - ((avgVuln - 1) / 9) * 0.4;
  const qW = Math.min(1, session.history.length / 20);
  const score = Math.round((accuracy * 0.45 + avgRet * 0.35 + vulnF * 0.2) * 100 * (0.7 + qW * 0.3));
  const color = score >= 75 ? C.green : score >= 55 ? C.amber : C.red;
  const label = score >= 75 ? "EXAM READY" : score >= 55 ? "PROGRESSING" : "CRITICAL";
  return (
    <Card style={{ padding: "14px 16px", textAlign: "center", border: `1px solid ${color}44` }}>
      <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 30, color, lineHeight: 1 }}>{score}%</div>
      <Mono s={8} c={color} style={{ display: "block", marginTop: 3, letterSpacing: "2px" }}>READINESS</Mono>
      <Mono s={7} c={C.textDim} style={{ display: "block", marginTop: 2 }}>{label}</Mono>
    </Card>
  );
}

// ─────────────────────────────────────────────
// VOICE BUTTON (Web Speech API)
// ─────────────────────────────────────────────
function VoiceBtn({ onResult }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const toggle = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Voice not supported. Use Chrome."); return; }
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    recRef.current = rec;
    rec.lang = "en-US"; rec.continuous = false; rec.interimResults = false;
    rec.onresult = (e) => { onResult(e.results[0][0].transcript); setListening(false); };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start(); setListening(true);
  };
  return (
    <button onClick={toggle} title={listening ? "Stop" : "Voice input"} style={{
      background: listening ? "rgba(217,64,64,0.15)" : C.surface,
      border: `1px solid ${listening ? C.red : C.border}`,
      color: listening ? C.red : C.textMid,
      padding: "0 14px", cursor: "pointer", fontSize: 16,
      animation: listening ? "pulse 1s infinite" : undefined,
      transition: "all 0.2s",
    }}>🎙</button>
  );
}

// ─────────────────────────────────────────────
// SCREEN: SPEED RUN
// ─────────────────────────────────────────────
function SpeedRunScreen({ session, dispatch, onBack }) {
  const [phase, setPhase] = useState("intro");
  const [timeLeft, setTimeLeft] = useState(60);
  const [q, setQ] = useState(null);
  const [loading, setLoading] = useState(false);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [flash, setFlash] = useState(null);
  const timerRef = useRef(null);
  const startRef = useRef(null);
  const sorted = [...session.topics].sort((a, b) => getUrgency(b) - getUrgency(a));
  const pickTopic = () => sorted[Math.floor(Math.random() * Math.min(5, sorted.length))];

  const fetchQ = useCallback(async () => {
    setLoading(true);
    const t = pickTopic();
    const data = await mistralJSON(P.NEMESIS, `Topic: ${t.name}. Vuln: ${t.vulnerability}/10. Keep question short. Context: ${session.rawCourses}`);
    if (data) setQ({ ...data, topicId: t.id });
    startRef.current = Date.now();
    setLoading(false);
  }, [session]);

  const start = async () => {
    setPhase("running"); setScore(0); setCombo(0); setAnswered(0); setCorrect(0); setTimeLeft(60);
    timerRef.current = setInterval(() => setTimeLeft(t => {
      if (t <= 1) { clearInterval(timerRef.current); setPhase("over"); return 0; }
      return t - 1;
    }), 1000);
    await fetchQ();
  };

  const answer = async (opt) => {
    if (!q || loading || phase !== "running") return;
    const elapsed = (Date.now() - startRef.current) / 1000;
    const speedBonus = Math.max(0, Math.round((8 - elapsed) * 3));
    const isCorrect = opt === q.correct;
    if (isCorrect) {
      const nc = combo + 1;
      setScore(s => s + 10 + speedBonus + nc * 2);
      setCombo(nc); setCorrect(c => c + 1); setFlash("hit");
    } else { setCombo(0); setFlash("miss"); }
    setAnswered(a => a + 1);
    dispatch({ type: "RECORD", topicId: q.topicId, correct: isCorrect, difficulty: q.difficulty || 5 });
    setTimeout(() => setFlash(null), 200);
    await fetchQ();
  };

  const threat = score > 300 ? "ELITE" : score > 150 ? "OPERATIVE" : score > 60 ? "RECRUIT" : "CADET";
  const tc = score > 300 ? C.green : score > 150 ? C.amberLight : score > 60 ? C.amber : C.red;

  return (
    <div style={{ minHeight: "100vh", background: flash === "hit" ? "rgba(42,157,92,0.06)" : flash === "miss" ? "rgba(217,64,64,0.08)" : C.bg, transition: "background 0.15s", padding: "28px 24px", maxWidth: 760, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <Btn onClick={onBack} v="ghost" sz="sm">← RETREAT</Btn>
        <h2 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "3px" }}>⚡ SPEED RUN — 60s BLITZ</h2>
      </div>

      {phase === "intro" && (
        <Card style={{ maxWidth: 500, animation: "fadeUp 0.4s ease" }}>
          <Label color={C.amberLight}>⚡ BLITZ MODE</Label>
          <p style={{ fontSize: 14, color: C.textMid, lineHeight: 1.75, marginTop: 14 }}>
            60 seconds. Answer as many questions as you can.<br />
            <span style={{ color: C.red }}>Speed bonus</span>: faster = more points.<br />
            <span style={{ color: C.amberLight }}>Combo</span>: consecutive correct answers stack the bonus.<br />
            No explanations. Pure instinct.
          </p>
          <div style={{ marginTop: 20 }}><Btn onClick={start} sz="lg">⚡ START BLITZ</Btn></div>
        </Card>
      )}

      {phase === "running" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 72, lineHeight: 1, color: timeLeft <= 10 ? C.red : timeLeft <= 20 ? C.amber : C.text, animation: timeLeft <= 10 ? "pulse 0.5s infinite" : undefined }}>{timeLeft}</div>
                <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px" }}>SEC</Mono>
              </div>
              <div style={{ width: 1, height: 60, background: C.border }} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 52, lineHeight: 1, color: C.amberLight }}>{score}</div>
                <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px" }}>PTS</Mono>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 36, lineHeight: 1, color: combo > 2 ? C.greenLight : C.textMid }}>×{combo}</div>
                <Mono s={9} c={C.textDim} style={{ letterSpacing: "2px" }}>COMBO</Mono>
              </div>
            </div>
            <Mono s={12} c={C.textMid}>{correct}/{answered}</Mono>
          </div>
          <div style={{ height: 3, background: C.surface, marginBottom: 20 }}>
            <div style={{ width: `${(timeLeft / 60) * 100}%`, height: "100%", background: timeLeft <= 10 ? C.red : C.amberLight, transition: "width 1s linear" }} />
          </div>
          {loading ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}><Dots /></div>
          ) : q ? (
            <div style={{ animation: "fadeUp 0.15s ease" }}>
              <Card hot style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <Label color={q.difficulty > 7 ? C.red : C.amber}>DIFF {q.difficulty}/10</Label>
                  <Label color={C.textDim}>{q.concept}</Label>
                </div>
                <p style={{ fontSize: 16, lineHeight: 1.7 }}>{q.question}</p>
              </Card>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {["A", "B", "C", "D"].map(opt => (
                  <div key={opt} onClick={() => answer(opt)} style={{
                    display: "flex", gap: 12, alignItems: "center", padding: "14px 16px",
                    background: C.surface, border: `1px solid ${C.border}`, cursor: "pointer",
                  }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = C.red}
                    onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
                  >
                    <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 22, color: C.red, width: 18, flexShrink: 0 }}>{opt}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.4 }}>{q.options?.[opt]}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {phase === "over" && (
        <div style={{ animation: "fadeUp 0.5s ease" }}>
          <Card hot style={{ textAlign: "center", padding: "48px 40px", marginBottom: 24 }}>
            <Mono s={10} c={C.textDim} style={{ letterSpacing: "3px", display: "block", marginBottom: 12 }}>BLITZ COMPLETE</Mono>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 96, lineHeight: 0.9, color: tc }}>{score}</div>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, color: tc, marginTop: 10, letterSpacing: "4px" }}>[ {threat} ]</div>
            <div style={{ marginTop: 16, color: C.textMid, fontSize: 14, display: "flex", justifyContent: "center", gap: 32 }}>
              <div><span style={{ color: C.green, fontWeight: 600 }}>{correct}</span> correct</div>
              <div><span style={{ color: C.red, fontWeight: 600 }}>{answered - correct}</span> missed</div>
              <div><span style={{ color: C.amberLight, fontWeight: 600 }}>{answered}</span> total</div>
            </div>
          </Card>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={start} sz="lg">⚡ RETRY</Btn>
            <Btn onClick={onBack} v="ghost" sz="lg">← WAR ROOM</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: INTEL BRIEFING
// ─────────────────────────────────────────────
function IntelBriefingScreen({ topic, session, onBack, onAttack }) {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    mistralJSON(P.INTEL,
      `Topic: ${topic.name}. Category: ${topic.category}. Failure mode: ${topic.failureMode}. Student courses: ${session.rawCourses}`
    ).then(b => { setBrief(b); setLoading(false); });
  }, []);

  const wc = !brief ? C.textDim : brief.warningLevel === "critical" ? C.red : brief.warningLevel === "elevated" ? C.amber : C.green;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: "28px 24px", maxWidth: 860, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
        <Btn onClick={onBack} v="ghost" sz="sm">← BACK</Btn>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <h2 style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "3px" }}>🔍 INTEL BRIEFING</h2>
            <Label>CLASSIFIED</Label>
            {brief && <Label color={wc}>{brief.warningLevel?.toUpperCase()}</Label>}
          </div>
          <Mono s={9} c={C.textDim}>TARGET: {topic.name?.toUpperCase()} — VULN {topic.vulnerability}/10</Mono>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "80px 0" }}>
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 24, color: C.red, letterSpacing: "4px" }}>GATHERING INTELLIGENCE<Dots /></div>
          <Mono s={10} c={C.textDim} style={{ display: "block", marginTop: 8 }}>Scanning failure modes — stand by...</Mono>
        </div>
      ) : brief ? (
        <div style={{ display: "grid", gap: 16, animation: "fadeUp 0.4s ease" }}>

          {/* Summary */}
          <Card hot style={{ padding: "22px 24px" }}>
            <Mono s={8} c={C.red} style={{ letterSpacing: "3px", display: "block", marginBottom: 8 }}>// THREAT ASSESSMENT</Mono>
            <p style={{ fontSize: 14, color: C.textMid, lineHeight: 1.9 }}>{brief.summary}</p>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Key Concepts */}
            <Card>
              <Mono s={9} c={C.amberLight} style={{ letterSpacing: "2px", display: "block", marginBottom: 14 }}>⚡ KEY CONCEPTS</Mono>
              {(brief.keyPoints || []).map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
                  <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 18, color: C.red, lineHeight: 1, flexShrink: 0, width: 20 }}>{i + 1}</div>
                  <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{p}</div>
                </div>
              ))}
            </Card>

            {/* Danger Zones */}
            <Card>
              <Mono s={9} c={C.red} style={{ letterSpacing: "2px", display: "block", marginBottom: 14 }}>⚠ DANGER ZONES</Mono>
              {(brief.commonTraps || []).map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                  <span style={{ color: C.red, fontSize: 16, flexShrink: 0, lineHeight: 1.2 }}>✗</span>
                  <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{t}</div>
                </div>
              ))}
            </Card>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Memory Trick */}
            <Card style={{ background: "rgba(42,127,212,0.04)", borderColor: "rgba(42,127,212,0.25)" }}>
              <Mono s={9} c={C.blueLight} style={{ letterSpacing: "2px", display: "block", marginBottom: 12 }}>🧠 MEMORY TRICK</Mono>
              <div style={{ fontSize: 15, color: C.text, lineHeight: 1.8, fontStyle: "italic" }}>{brief.mnemonic}</div>
            </Card>

            {/* Self Test */}
            <Card style={{ background: "rgba(42,157,92,0.04)", borderColor: "rgba(42,157,92,0.25)" }}>
              <Mono s={9} c={C.greenLight} style={{ letterSpacing: "2px", display: "block", marginBottom: 12 }}>🎯 SELF-TEST</Mono>
              <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.8 }}>{brief.quickTest}</div>
            </Card>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={() => onAttack(topic)} sz="lg">⚔ ATTACK THIS TOPIC</Btn>
            <Btn onClick={onBack} v="ghost" sz="lg">← WAR ROOM</Btn>
          </div>
        </div>
      ) : (
        <Mono s={11} c={C.red}>Intel retrieval failed. Retry.</Mono>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// SCREEN: BOOT SEQUENCE (CINEMATIC INTRO)
// ─────────────────────────────────────────────
function BootSequence({ onComplete }) {
  const [step, setStep] = useState(0);
  const msgs = [
    "INITIALIZING NEURAL LINK...",
    "SYNCING KNOWLEDGE TOPOLOGY...",
    "ESTABLISHING CONNECTION TO ORCHESTRATOR...",
    "DECRYPTING MISSION FILES...",
    "BYPASSING COGNITIVE FIREWALLS...",
    "ACCESS GRANTED."
  ];

  useEffect(() => {
    const intervals = [600, 1400, 2200, 3000, 3800, 4600];
    intervals.forEach((delay, i) => {
      setTimeout(() => setStep(i + 1), delay);
    });
    setTimeout(onComplete, 6000);
  }, [onComplete]);

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: C.green, padding: "40px 10%", fontFamily: "'IBM Plex Mono', monospace", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ maxWidth: 800, width: "100%" }}>
        {msgs.slice(0, step).map((m, i) => (
          <div key={i} style={{ marginBottom: 16, fontSize: i === msgs.length - 1 ? 24 : 14, fontWeight: i === msgs.length - 1 ? "bold" : "normal", animation: "fadeUp 0.1s ease", textShadow: `0 0 10px ${C.green}80` }}>
            <span style={{ opacity: 0.5 }}>[{Date.now() + i * 100}]</span> {m}
          </div>
        ))}
        {step < msgs.length && <BlinkingDot />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("boot");
  const [session, dispatch] = useReducer(reducer, init);
  const [battleTopic, setBattleTopic] = useState(null);
  const [battleMode, setBattleMode] = useState("nemesis");
  const [socratesTopic, setSocratesTopic] = useState(null);
  const [intelTopic, setIntelTopic] = useState(null);

  const handleStart = (payload) => { dispatch({ type: "INIT", p: payload }); setScreen("warroom"); };
  const handleGoBattle = (topic, mode = "nemesis") => { setBattleTopic(topic); setBattleMode(mode); setScreen("battle"); };
  const handleGoSocrates = (topic) => { setSocratesTopic(topic); setScreen("socrates"); };
  const handleGoExam = () => setScreen("exam");
  const handleGoSpeedRun = () => setScreen("speedrun");
  const handleGoIntel = (topic) => { setIntelTopic(topic); setScreen("intel"); };
  const handleGoAvatars = () => setScreen("avatars");

  return (
    <>
      <style>{CSS}</style>
      {screen === "boot" && <BootSequence onComplete={() => setScreen("welcome")} />}
      {screen === "welcome" && <WelcomeScreen onStart={handleStart} />}
      {screen === "warroom" && (
        <WarRoomScreen
          session={session} dispatch={dispatch}
          onGoBattle={handleGoBattle} onGoSocrates={handleGoSocrates}
          onGoExam={handleGoExam} onGoSpeedRun={handleGoSpeedRun} onGoIntel={handleGoIntel}
          onGoAvatars={handleGoAvatars}
        />
      )}
      {screen === "battle" && battleTopic && (
        <BattleScreen topic={battleTopic} mode={battleMode} session={session} dispatch={dispatch} onBack={() => setScreen("warroom")} />
      )}
      {screen === "socrates" && socratesTopic && (
        <SocratesScreen topic={socratesTopic} session={session} onBack={() => setScreen("warroom")} />
      )}
      {screen === "exam" && (
        <ExamScreen session={session} dispatch={dispatch} onBack={() => setScreen("warroom")} />
      )}
      {screen === "speedrun" && (
        <SpeedRunScreen session={session} dispatch={dispatch} onBack={() => setScreen("warroom")} />
      )}
      {screen === "intel" && intelTopic && (
        <IntelBriefingScreen topic={intelTopic} session={session} onBack={() => setScreen("warroom")}
          onAttack={(t) => { setBattleTopic(t); setBattleMode("nemesis"); setScreen("battle"); }}
        />
      )}
      {screen === "avatars" && (
        <AvatarRoomScreen session={session} onBack={() => setScreen("warroom")} />
      )}
    </>
  );
}
