/* ============================================================
   klang.js · Synthetisierte Sounds für die Casino-Spiele
   ------------------------------------------------------------
   Echte Automaten arbeiten massiv mit Ton: Surren baut Spannung
   auf, jeder Walzenstopp "tickt", Gewinne klingeln umso länger,
   je größer sie sind. Dieses Modul liefert genau das – aber ohne
   eine einzige Audiodatei: Alle Klänge entstehen zur Laufzeit mit
   der Web-Audio-API (Oszillatoren + Hüllkurven). Dadurch bleibt
   die Seite komplett frei von externen Ressourcen.

   WICHTIG (Browser-Regel): Audio darf erst nach einer Nutzer-
   Geste starten ("Autoplay-Policy"). Deshalb wird der AudioContext
   erst beim ersten Aufruf erzeugt bzw. mit resume() geweckt – der
   erste Dreh-Klick ist diese Geste.

   Ton an/aus wird global gespeichert (ba:global:ton) und gilt
   für alle Casino-Spiele gemeinsam. Jede Seite baut sich mit
   tonKnopf(container) einen Umschalter.
   ============================================================ */

import { lade, speichere } from "./storage.js";

let ctx = null;          // AudioContext – erst bei Bedarf erzeugen
let master = null;       // zentrale Lautstärke

function kontext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;                  // sehr alte Browser: stumm
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;              // insgesamt dezent bleiben
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** Ist der Ton gerade eingeschaltet? (global für alle Casino-Spiele) */
export function istTonAn() {
  return lade("global", "ton", true) === true;
}

/** Schaltet den Ton um und gibt den neuen Zustand zurück. */
export function tonUmschalten() {
  const neu = !istTonAn();
  speichere("global", "ton", neu);
  return neu;
}

/* ---------- interne Klang-Bausteine --------------------------- */

/** Kurzer Einzelton: frequenz (Hz), dauer (s), typ, lautstärke 0..1. */
function ton(frequenz, dauer, typ = "square", laut = 0.5, start = 0) {
  if (!istTonAn()) return;
  const c = kontext();
  if (!c) return;
  const osc = c.createOscillator();
  const huelle = c.createGain();
  osc.type = typ;
  osc.frequency.value = frequenz;
  // Hüllkurve: sofort an, exponentiell aus – klingt "knackig" statt klickend
  const t0 = c.currentTime + start;
  huelle.gain.setValueAtTime(laut, t0);
  huelle.gain.exponentialRampToValueAtTime(0.001, t0 + dauer);
  osc.connect(huelle).connect(master);
  osc.start(t0);
  osc.stop(t0 + dauer + 0.02);
}

/** Kurzes Rauschen (für Stopps und das Spin-Surren). */
function rauschen(dauer, laut = 0.3, start = 0, tiefpass = 1200) {
  if (!istTonAn()) return;
  const c = kontext();
  if (!c) return;
  const puffer = c.createBuffer(1, c.sampleRate * dauer, c.sampleRate);
  const daten = puffer.getChannelData(0);
  for (let i = 0; i < daten.length; i++) daten[i] = Math.random() * 2 - 1;
  const quelle = c.createBufferSource();
  quelle.buffer = puffer;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = tiefpass;
  const huelle = c.createGain();
  const t0 = c.currentTime + start;
  huelle.gain.setValueAtTime(laut, t0);
  huelle.gain.exponentialRampToValueAtTime(0.001, t0 + dauer);
  quelle.connect(filter).connect(huelle).connect(master);
  quelle.start(t0);
}

/* ---------- öffentliche Spiel-Klänge -------------------------- */

/** Dreh-Start: kurzes tiefes "Anwerfen". */
export function klangSpinStart() {
  rauschen(0.25, 0.18, 0, 500);
  ton(110, 0.15, "sawtooth", 0.15);
}

/** Walzenstopp i (0-basiert): Tick, pro Walze minimal höher. */
export function klangWalzenStopp(i = 0) {
  ton(220 + i * 40, 0.06, "square", 0.3);
  rauschen(0.04, 0.12, 0, 2500);
}

/** Spannung ("Anticipation"): aufsteigender Herzschlag-Riser. */
export function klangSpannung() {
  for (let i = 0; i < 6; i++) ton(90 + i * 25, 0.1, "sine", 0.35, i * 0.12);
}

/** Knapp vorbei: zwei fallende Töne ("ooh…"). */
export function klangFastGewinn() {
  ton(392, 0.12, "triangle", 0.3);
  ton(311, 0.22, "triangle", 0.25, 0.13);
}

/**
 * Gewinn-Jingle nach Feier-Stufe (0–3): je größer der Gewinn,
 * desto länger und höher das Arpeggio – wie am echten Gerät.
 */
export function klangGewinn(stufe = 0) {
  const toene = [262, 330, 392, 523, 659, 784, 1047, 1319];  // C-Dur aufwärts
  const anzahl = [3, 5, 8, 12][Math.max(0, Math.min(3, stufe))];
  for (let i = 0; i < anzahl; i++) {
    ton(toene[i % toene.length] * (1 + Math.floor(i / toene.length)), 0.14, "square", 0.3, i * 0.09);
  }
}

/** Münz-Tick für hochzählende Beträge (sparsam aufrufen, z. B. alle 60 ms). */
export function klangMuenzTick() {
  ton(1568 + Math.random() * 300, 0.04, "square", 0.12);
}

/* ---------- Klänge des Risiko-Features (assets/risiko.js) ------ */

/**
 * Blink-Tick der Risikoleiter: sehr leise und kurz, denn er läuft im Takt des
 * Flackerns (mehrmals pro Sekunde). Hoher Ton = die nächste Stufe leuchtet,
 * tiefer Ton = die Null leuchtet. Wer genau hinhört, hört das Wechselspiel.
 */
export function klangBlinkTick(hoch = true) {
  ton(hoch ? 740 : 294, 0.03, "square", 0.05);
}

/** Absturz: fünf schnell fallende Töne und ein dumpfer Schlag am Ende. */
export function klangAbsturz() {
  for (let i = 0; i < 5; i++) ton(520 * Math.pow(0.76, i), 0.13, "sawtooth", 0.28, i * 0.09);
  ton(70, 0.3, "sine", 0.45, 0.46);
  rauschen(0.25, 0.15, 0.46, 400);
}

/** Karte wird umgedreht: kurzes "Fwip" (Rauschen) und ein heller Klick. */
export function klangKartenFlip() {
  rauschen(0.08, 0.16, 0, 3200);
  ton(560, 0.05, "triangle", 0.16, 0.06);
}

/* ---------- Ton-Umschalter (UI) -------------------------------- */

/**
 * Baut einen kleinen Ton-an/aus-Knopf in den Container (z. B. den
 * .spiel-kopf). Beschriftung über Symbol + aria-label, Zustand
 * wird gespeichert und gilt seitenübergreifend.
 */
export function tonKnopf(container) {
  const knopf = document.createElement("button");
  knopf.className = "knopf ton-knopf";
  knopf.type = "button";
  const anzeigen = () => {
    knopf.textContent = istTonAn() ? "♪ Ton an" : "♪ Ton aus";
    knopf.setAttribute("aria-pressed", String(istTonAn()));
    knopf.setAttribute("aria-label", istTonAn() ? "Ton ausschalten" : "Ton einschalten");
  };
  knopf.addEventListener("click", () => { tonUmschalten(); anzeigen(); if (istTonAn()) klangWalzenStopp(1); });
  anzeigen();
  container.append(knopf);
  return knopf;
}
