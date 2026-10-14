/* ============================================================
   risiko.js · Das Risiko-Feature deutscher Spielautomaten
   ------------------------------------------------------------
   SO FUNKTIONIERT DIESES MODUL
   1. Idee: Nach einem Gewinn darf der Spieler ENTSCHEIDEN: den Gewinn
      "sammeln" (auf das Konto) oder "riskieren". Riskieren heißt: Mit einer
      Chance von 50 % wird der Gewinn verdoppelt, mit 50 % ist er weg. Echte
      deutsche Geräte (Merkur und Co.) bieten genau das an, in zwei Formen:
        - RISIKOLEITER: eine senkrechte Leiter mit den Stufen x1, x2, x4, x8,
          x16, x32 des Gewinns. Die nächste Stufe und die "0" BLINKEN im
          Wechsel (das typische Flackern). Mit "Riskieren" stoppt das Blinken:
          leuchtet am Ende die Stufe, geht es eine Sprosse hoch, leuchtet die
          Null, stürzt man ab. Jederzeit darf man sammeln.
        - ROT/SCHWARZ (Kartenrisiko): Eine verdeckte Karte, man tippt auf ihre
          Farbe. Richtig = Betrag x2 und die Karte klappt auf, falsch = 0.
   2. Die Regeln sind REINE FUNKTIONEN ohne DOM (leiterStufen, risikoZiehen,
      kartenZiehen, leiterSchritt, kartenSchritt, leiterTabelle ...). Der Zufall
      ist als Parameter austauschbar (Standard Math.random). Deshalb kann Node
      sie testen, auch mit erzwungenen Ergebnissen.
   3. WARUM DAS EV-NEUTRAL IST (die Mathe-Pointe): Beide Modi sind exakt 50/50.
      Setzt man einen Betrag B ein, gibt es mit 50 % den Betrag 2B und mit 50 %
      den Betrag 0. Der Erwartungswert ist 0,5 x 2B + 0,5 x 0 = B. Auf lange
      Sicht ändert das Riskieren am Geld also NICHTS: weder Vorteil noch
      Nachteil. Auch das mehrfache Hochklettern ändert daran nichts: Wer bis
      Stufe n will, schafft das mit 0,5 hoch n und kassiert dann 2 hoch n mal
      den Start. Das Produkt ist wieder genau der Start. Was sich ändert, ist
      die STREUUNG (Varianz): Aus einem sicheren Gewinn wird eine Lotterie mit
      riesigen Ausreißern nach oben und sehr vielen Totalverlusten.
      FAIRNESS: Das ist ehrlicher als manche echten Geräte, bei denen die
      Gewinnchance im Risiko-Modus unter 50 % liegen kann. Hier ist sie exakt
      50 %, und die Tests prüfen das (siehe tests/risiko-test.mjs).
   4. Aufbau des Moduls:
        TEIL 1  reine Funktionen (Stufen, Zufall, Karte, Schritte, Tabelle)
        TEIL 2  die Leiter als wiederverwendbare UI-Komponente: leiterBauen().
                Die Slots-Overlay UND das Solo-Spiel "Risikoleiter" benutzen
                DIESELBE Komponente (kein doppelter Code).
        TEIL 3  das Kartenrisiko als Komponente: kartenBauen()
        TEIL 4  das Overlay für die Slots: risikoAnbieten({ buehne, betrag,
                einsatz, maxBetrag }) -> Promise mit dem ENDBETRAG
                (0 bei Verlust, betrag bei Sammeln, mehr bei Erfolg).
   5. GELD: Dieses Modul rührt kein Konto an. Es meldet über den Rückruf
      beiAenderung(sicherBetrag) jederzeit, wie viel gerade sicher ist (nach
      jeder Ziehung sofort, auch mitten in der Blink-Animation). Das Spiel
      merkt sich diesen Wert und bucht ihn bei "pagehide" (Seite wird
      verlassen). So kann man weder durch Neuladen einen Verlust ungeschehen
      machen noch durch Weggehen einen Gewinn verlieren: Das Ergebnis steht
      fest, bevor die Animation startet (wie bei den Slots).
   6. SICHERHEIT GEGEN VERSEHEN: Esc, der Klick neben das Fenster und die
      Taste S bedeuten immer "Sammeln". Nach 20 Sekunden ohne Eingabe wird
      automatisch gesammelt: Niemand verliert Geld, nur weil er weggeht. Die
      riskanten Knöpfe sind in den ersten 0,4 Sekunden gesperrt, damit ein
      Doppelklick oder die noch gedrückte Leertaste vom Dreh nichts auslöst.
   7. BEWEGUNG REDUZIEREN: Dann blinkt nichts (die nächste Stufe und die Null
      sind stattdessen dauerhaft markiert), die Karte erscheint ohne Flip, es
      gibt kein Auslaufen. Ergebnisse sehen trotzdem alle.
   ============================================================ */

import { bewegungReduziert } from "./ui.js";
import { klangGewinn, klangBlinkTick, klangAbsturz, klangKartenFlip } from "./klang.js";

/* ============================================================
   TEIL 1: REINE LOGIK (ohne DOM, in Node testbar)
   ============================================================ */

/** Die Sprossen der Leiter als Vielfache des Startbetrags: jede Stufe verdoppelt. */
export const RISIKO_FAKTOREN = [1, 2, 4, 8, 16, 32];

/** Weniger Stufen als das passen unter das Limit, ist es keine Leiter mehr (dann bleibt nur Rot/Schwarz). */
export const MIN_LEITER_STUFEN = 3;

/** Nach so vielen Millisekunden ohne Eingabe wird automatisch gesammelt. */
export const RISIKO_TIMEOUT_MS = 20000;

/** Gewinnchance jedes einzelnen Risiko-Schritts: genau 50 %. */
export const RISIKO_CHANCE = 0.5;

const BLINK_MS = 230;               // Takt des Flackerns (Stufe und Null wechseln sich so schnell ab)
const SPERRE_MS = 400;              // so lange sind die riskanten Knöpfe nach dem Erscheinen gesperrt
const FADE_MS = 180;                // Ausblenden des Overlays

/**
 * Die Stufen der Leiter für einen Startbetrag: betrag x 1, x2, x4 ... x32,
 * aber nur so viele, wie unter das Limit `maxBetrag` passen. Ein Betrag, der
 * über dem Limit läge, gibt es nie: Die Leiter endet VOR dem Limit, sie wird
 * nicht "abgeschnitten" (ein abgeschnittener Gipfel wäre keine Verdopplung
 * mehr und der Schritt wäre nicht mehr EV-neutral).
 * Beispiele: (250, 5000) -> [250, 500, 1000, 2000, 4000]
 *            (1500, 5000) -> [1500, 3000]    (zu kurz für eine Leiter)
 *            (6000, 5000) -> []
 */
export function leiterStufen(betrag, maxBetrag = Infinity) {
  if (!Number.isFinite(betrag) || betrag <= 0) return [];
  const stufen = [];
  for (const faktor of RISIKO_FAKTOREN) {
    const wert = betrag * faktor;
    if (wert > maxBetrag) break;
    stufen.push(wert);
  }
  return stufen;
}

/** Ist eine Leiter möglich? Sie braucht mindestens MIN_LEITER_STUFEN Stufen (inklusive der Startstufe). */
export function leiterMoeglich(betrag, maxBetrag = Infinity) {
  return leiterStufen(betrag, maxBetrag).length >= MIN_LEITER_STUFEN;
}

/** Ist Rot/Schwarz möglich? Dafür muss die Verdopplung noch unter das Limit passen. */
export function kartenMoeglich(betrag, maxBetrag = Infinity) {
  return Number.isFinite(betrag) && betrag > 0 && betrag * 2 <= maxBetrag;
}

/** Gibt es überhaupt ein Risiko-Angebot (mindestens eine Verdopplung)? */
export function risikoMoeglich(betrag, maxBetrag = Infinity) {
  return kartenMoeglich(betrag, maxBetrag);
}

/**
 * Die 50/50-Ziehung. true = gewonnen (eine Stufe höher, Betrag x2), false = Absturz auf 0.
 *
 * `zufall()` liefert z mit 0 <= z < 1, gleichmäßig verteilt. Genau die untere
 * Hälfte des Bereichs (z < 0,5) bedeutet "gewonnen": Die Gewinnchance ist
 * damit exakt 0,5, nicht 49 % und nicht 51 %. Math.random() reicht hier völlig:
 * Es geht um Spielgeld, niemand kann etwas Echtes gewinnen.
 */
export function risikoZiehen(zufall = Math.random) {
  return zufall() < RISIKO_CHANCE;
}

/** Die vier Kartenfarben: die ersten beiden sind ROT, die letzten beiden SCHWARZ (je 13 Karten). */
export const KARTEN_SYMBOLE = [
  { symbol: "♥", farbe: "rot", name: "Herz" },
  { symbol: "♦", farbe: "rot", name: "Karo" },
  { symbol: "♠", farbe: "schwarz", name: "Pik" },
  { symbol: "♣", farbe: "schwarz", name: "Kreuz" },
];
export const KARTEN_WERTE = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "B", "D", "K", "A"];
const WERT_NAMEN = { B: "Bube", D: "Dame", K: "König", A: "Ass" };

/**
 * Zieht eine Karte aus einem vollen 52er-Blatt (mit Zurücklegen: jede Ziehung
 * ist unabhängig). Ein einziger Zufallswert wird in 52 gleich große Streifen
 * geteilt. Die ersten 26 Streifen (Herz, Karo) sind rot, die letzten 26 (Pik,
 * Kreuz) schwarz: Rot und Schwarz sind exakt gleich wahrscheinlich, 26 von 52.
 * Rückgabe: { index, farbe, symbol, symbolName, wert, name }
 */
export function kartenZiehen(zufall = Math.random) {
  const index = Math.min(51, Math.floor(zufall() * 52));    // min(): falls ein Test-Zufall genau 1 liefert
  const symbol = KARTEN_SYMBOLE[Math.floor(index / 13)];
  const wert = KARTEN_WERTE[index % 13];
  return {
    index,
    farbe: symbol.farbe,
    symbol: symbol.symbol,
    symbolName: symbol.name,
    wert,
    name: `${symbol.name} ${WERT_NAMEN[wert] ?? wert}`,
  };
}

/** Stimmt der Tipp ("rot" | "schwarz") mit der Farbe der Karte überein? */
export function kartenTippAuswerten(tipp, karte) {
  return karte.farbe === tipp;
}

/**
 * EIN Schritt der Leiter. `stufen` kommt aus leiterStufen(), `stufe` ist der
 * aktuelle Index (0 = Start). Nur aufrufen, solange es eine nächste Stufe gibt.
 * Rückgabe: { gewonnen, stufe, betrag, oben }
 *   gewonnen  true = eine Stufe höher, false = Absturz
 *   stufe     neuer Index (bei Absturz unverändert, die Leiter ist dann zu Ende)
 *   betrag    der Betrag, der JETZT sicher ist (Stufenwert oder 0)
 *   oben      true, wenn die oberste Stufe erreicht wurde (dann wird gesammelt)
 */
export function leiterSchritt(stufen, stufe, zufall = Math.random) {
  if (!risikoZiehen(zufall)) return { gewonnen: false, stufe, betrag: 0, oben: false };
  const neu = stufe + 1;
  return { gewonnen: true, stufe: neu, betrag: stufen[neu], oben: neu === stufen.length - 1 };
}

/**
 * EIN Schritt des Kartenrisikos: Karte ziehen, Tipp prüfen.
 * Rückgabe: { karte, richtig, betrag, weiter }
 *   betrag  der Betrag, der JETZT sicher ist (doppelt oder 0)
 *   weiter  true, wenn man noch einmal riskieren dürfte (Verdopplung passt unters Limit)
 */
export function kartenSchritt(betrag, tipp, maxBetrag = Infinity, zufall = Math.random) {
  const karte = kartenZiehen(zufall);
  const richtig = kartenTippAuswerten(tipp, karte);
  const neu = richtig ? betrag * 2 : 0;
  return { karte, richtig, betrag: neu, weiter: richtig && kartenMoeglich(neu, maxBetrag) };
}

/**
 * Die Lern-Tabelle der Leiter: Was passiert, wenn man bis zur Stufe i hochklettern WILL
 * (und dort sammelt)? Eine Zeile pro Stufe:
 *   chance      0,5 hoch i: so wahrscheinlich ist es, diese Stufe lebend zu erreichen
 *   verlust     1 minus chance: so wahrscheinlich ist der Totalverlust auf dem Weg
 *   erwartung   chance x Betrag: der Erwartungswert, immer genau der Startbetrag
 *   streuung    Standardabweichung dieses Plans: Betrag x Wurzel(chance x (1 - chance))
 * Die Erwartung bleibt in jeder Zeile gleich, die Streuung explodiert: Das ist
 * der Unterschied zwischen Erwartungswert und Varianz.
 */
export function leiterTabelle(betrag, maxBetrag = Infinity) {
  return leiterStufen(betrag, maxBetrag).map((wert, i) => {
    const chance = Math.pow(RISIKO_CHANCE, i);
    return {
      stufe: i,
      faktor: RISIKO_FAKTOREN[i],
      betrag: wert,
      chance,
      verlust: 1 - chance,
      erwartung: chance * wert,
      streuung: wert * Math.sqrt(chance * (1 - chance)),
    };
  });
}

/** Zahl mit Tausenderpunkt: 1250 -> "1.250". */
function zahlText(n) {
  return Math.round(n).toLocaleString("de-DE");
}

/** Netto mit Vorzeichen und echtem Minuszeichen: 240 -> "+240", -10 -> "−10", 0 -> "±0". */
function nettoText(n) {
  if (n > 0) return `+${zahlText(n)}`;
  if (n < 0) return `−${zahlText(-n)}`;
  return "±0";
}

/* ============================================================
   TEIL 2: KLEINE DOM-HELFER
   ============================================================ */

/** Element mit Klasse und optionalem Text (textContent: nie ungeprüftes HTML). */
function el(tag, klasse, text) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Knopf bauen. */
function knopf(text, klasse, beiKlick) {
  const k = el("button", klasse, text);
  k.type = "button";
  k.addEventListener("click", beiKlick);
  return k;
}

/**
 * Ruft einen Klang auf und fängt jeden Fehler ab: Der Ton ist Beiwerk und darf
 * nie den Ablauf stören (ein blockierter AudioContext, fehlende Web-Audio-API ...).
 */
function klingen(klang, ...argumente) {
  try {
    klang(...argumente);
  } catch {
    /* absichtlich leer: dann bleibt es eben stumm */
  }
}

/** Ruft einen optionalen Rückruf auf; ein Fehler darin darf das Risiko-Feature nie zerlegen. */
function rueckruf(funktion, ...argumente) {
  try {
    funktion?.(...argumente);
  } catch {
    /* absichtlich leer */
  }
}

/** Tastendruck, den eine Komponente NICHT behandeln soll (Browser-Kürzel, Eingabefelder, offene Dialoge). */
function tasteIgnorieren(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return true;
  if (document.querySelector("dialog[open]")) return true;
  const tag = e.target instanceof Element ? e.target.tagName : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Eine Taste auf einem Knopf, Link oder Aufklapper hat schon ihre eigene Wirkung (Leertaste = Klick). */
function tasteAufBedienelement(e) {
  const tag = e.target instanceof Element ? e.target.tagName : "";
  return tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
}

/* ============================================================
   TEIL 3: DIE LEITER ALS KOMPONENTE
   ------------------------------------------------------------
   leiterBauen() liefert ein fertiges Element (die Leiter, die Infozeile und
   die Knöpfe SAMMELN und RISKIEREN) plus eine kleine Steuerung. Sie kennt
   weder Konto noch Slots: Beträge laufen nur über die Rückrufe.
     betrag        Startbetrag = Stufe x1
     maxBetrag     Limit: keine Stufe darüber
     zufall        austauschbarer Zufall (Tests)
     vorschau      true = nur die Leiter zeigen (keine Knöpfe, kein Blinken, keine Tasten)
     beiAenderung  (sicherBetrag) SOFORT nach jeder Ziehung: so viel ist jetzt sicher
     beiErgebnis   ({ art: "auf" | "ab", betrag }) wenn die Animation gelandet ist
     tastatur      Leertaste = riskieren, S = sammeln
   Rückgabe: { element, ende, riskieren, sammeln, zerstoeren, phase, betrag }
     ende          Promise -> { betrag, grund: "sammeln" | "oben" | "absturz" }
   ============================================================ */

export function leiterBauen({
  betrag,
  maxBetrag = Infinity,
  zufall = Math.random,
  vorschau = false,
  beiAenderung = () => {},
  beiErgebnis = () => {},
  tastatur = !vorschau,
  sperreMs = SPERRE_MS,
} = {}) {
  const stufen = leiterStufen(betrag, maxBetrag);
  if (stufen.length === 0) stufen.push(betrag);          // ungültige Eingabe: wenigstens der Startbetrag bleibt sicher
  const letzte = stufen.length - 1;
  const reduziert = bewegungReduziert();

  // ----- Zustand -----
  let stufe = 0;                       // aktueller Index (0 = Start)
  let phase = vorschau ? "vorschau" : "wartet";   // "wartet" | "ziehen" | "ende" | "vorschau"
  let nullLeuchtet = false;            // Blinken: true = die Null leuchtet, false = die nächste Stufe
  let blinkTimer = 0;
  let endeTimer = 0;
  let fertig = false;
  let bereitAb = performance.now() + sperreMs;   // riskieren erst ab diesem Zeitpunkt
  let endeAufloesen = () => {};
  let endeSofort = () => {};           // überspringt die Pause am Ende (Absturz, Gipfel)
  const ende = new Promise((aufloesen) => { endeAufloesen = aufloesen; });

  // ----- Aufbau -----
  const wurzel = el("div", `rk-leiter${vorschau ? " vorschau" : ""}${reduziert ? " reduziert" : ""}`);
  const liste = el("ol", "rk-stufen");
  liste.setAttribute("aria-label", "Risikoleiter, oberste Stufe zuerst");
  const zeilen = [];                   // zeilen[i] = Zeile der Stufe i (0 = Start)
  // Oben beginnen: Die DOM-Reihenfolge ist die Lese-Reihenfolge (oberste Stufe zuerst).
  for (let i = letzte; i >= 0; i--) {
    const zeile = el("li", "rk-stufe");
    zeile.append(
      el("span", "rk-marke"),
      el("span", "rk-faktor", `×${RISIKO_FAKTOREN[i]}`),
      el("span", "rk-wert", zahlText(stufen[i])),
    );
    zeile.children[0].setAttribute("aria-hidden", "true");
    zeilen[i] = zeile;
    liste.append(zeile);
  }
  const nullZeile = el("li", "rk-null");
  nullZeile.append(el("span", "rk-marke", "✕"), el("span", "rk-faktor", "0"), el("span", "rk-wert", "Absturz"));
  nullZeile.children[0].setAttribute("aria-hidden", "true");
  liste.append(nullZeile);
  wurzel.append(liste);

  const info = el("p", "rk-info");
  info.setAttribute("aria-live", "polite");
  wurzel.append(info);

  let sammelnKnopf = null;
  let riskierenKnopf = null;
  if (!vorschau) {
    const aktionen = el("div", "rk-aktionen");
    sammelnKnopf = knopf("Sammeln", "knopf primaer rk-sammeln", () => sammeln());
    riskierenKnopf = knopf("RISKIEREN", "knopf rk-riskieren", () => riskieren());
    riskierenKnopf.setAttribute("aria-keyshortcuts", "Space");
    sammelnKnopf.setAttribute("aria-keyshortcuts", "S");
    aktionen.append(sammelnKnopf, riskierenKnopf);
    wurzel.append(aktionen);
  }

  // ----- Anzeige -----

  /** Klassen der Zeilen passend zur aktuellen Stufe setzen. */
  function anzeigen() {
    zeilen.forEach((zeile, i) => {
      zeile.classList.toggle("geschafft", i < stufe);
      zeile.classList.toggle("aktuell", i === stufe);
      zeile.classList.toggle("naechste", i === stufe + 1 && phase === "wartet");   // dauerhafte Markierung (auch ohne Blinken)
      zeile.classList.toggle("oben", i === letzte);
      zeile.classList.remove("blink", "getroffen", "neu");
      zeile.children[0].textContent = i < stufe ? "✓" : i === stufe ? "▶" : "";
      if (i === stufe) zeile.setAttribute("aria-current", "step");
      else zeile.removeAttribute("aria-current");
      zeile.setAttribute("aria-label", `Stufe ${i + 1} von ${stufen.length}: ${zahlText(stufen[i])}`);
    });
    nullZeile.classList.remove("blink", "getroffen");
    nullZeile.classList.toggle("scharf", phase === "wartet");
  }

  function infoSetzen(text) {
    info.textContent = text;
  }

  function knoepfeSchalten(an) {
    if (sammelnKnopf) sammelnKnopf.disabled = !an;
    if (riskierenKnopf) riskierenKnopf.disabled = !an;
  }

  // ----- Das Blinken -----

  /** Lässt entweder die nächste Stufe oder die Null leuchten (und tickt dezent dazu). */
  function leuchtenSetzen(nullAn, mitTon) {
    nullLeuchtet = nullAn;
    zeilen[stufe + 1]?.classList.toggle("blink", !nullAn);
    nullZeile.classList.toggle("blink", nullAn);
    if (mitTon) klingen(klangBlinkTick, !nullAn);
  }

  function blinkStoppen() {
    clearInterval(blinkTimer);
    clearTimeout(blinkTimer);
    blinkTimer = 0;
  }

  /** Das typische Flackern: Stufe und Null wechseln sich in schnellem Takt ab. Bei reduzierter Bewegung gar nicht. */
  function blinkStarten() {
    blinkStoppen();
    if (reduziert || phase !== "wartet" || vorschau) return;
    leuchtenSetzen(false, false);
    blinkTimer = setInterval(() => leuchtenSetzen(!nullLeuchtet, true), BLINK_MS);
  }

  /**
   * Das Ergebnis steht beim Druck auf RISKIEREN schon fest. Dies ist nur das
   * "Auslaufen" des Blinkens (wie der Spannungs-Stopp der Slots): Der Takt wird
   * langsamer und bleibt auf dem Ergebnis stehen. Vier oder fünf Wechsel, je
   * nachdem, wie herum gerade geleuchtet wird, damit das Licht genau auf
   * dem Ergebnis landet. Danach eine kurze Atempause.
   */
  function auslaufen(zielNull) {
    if (reduziert) return new Promise((fertigEr) => { blinkTimer = setTimeout(fertigEr, 250); });
    return new Promise((fertigEr) => {
      const anzahl = nullLeuchtet === zielNull ? 4 : 5;
      const pausen = [130, 170, 230, 320, 450].slice(5 - anzahl);
      let i = 0;
      const wechsel = () => {
        leuchtenSetzen(!nullLeuchtet, true);
        i++;
        blinkTimer = setTimeout(i < anzahl ? wechsel : fertigEr, i < anzahl ? pausen[i] : 350);
      };
      blinkTimer = setTimeout(wechsel, pausen[0]);
    });
  }

  // ----- Ablauf -----

  function aufraeumen() {
    blinkStoppen();
    clearTimeout(endeTimer);
    document.removeEventListener("keydown", taste);
  }

  function beenden(ergebnis) {
    if (fertig) return;
    fertig = true;
    phase = "ende";
    aufraeumen();
    endeAufloesen(ergebnis);
  }

  /** Nach einer kurzen Anzeige (Absturz, Gipfel) das Ende melden. Ein Klick/Esc darf überspringen. */
  function endeNachPause(ergebnis, ms) {
    phase = "ende";
    knoepfeSchalten(false);
    endeTimer = setTimeout(() => beenden(ergebnis), reduziert ? Math.min(ms, 900) : ms);
    endeSofort = () => beenden(ergebnis);
  }

  /** Einsammeln. Im Ende-Zustand (Anzeige läuft) überspringt es nur die Pause; während der Ziehung wirkt es nicht. */
  function sammeln() {
    if (fertig || phase === "vorschau" || phase === "ziehen") return;
    if (phase === "ende") {
      endeSofort();
      return;
    }
    beenden({ betrag: stufen[stufe], grund: "sammeln" });
  }

  /** RISKIEREN: 50/50 ziehen. Das Ergebnis und der sichere Betrag stehen SOFORT fest, die Animation zeigt es nur an. */
  async function riskieren() {
    if (fertig || phase !== "wartet" || stufe >= letzte) return;
    if (performance.now() < bereitAb) return;             // Schutz gegen Doppelklick / gedrückte Taste
    phase = "ziehen";
    blinkStoppen();
    knoepfeSchalten(false);
    zeilen[stufe + 1]?.classList.remove("naechste");
    nullZeile.classList.remove("scharf");

    const schritt = leiterSchritt(stufen, stufe, zufall);
    rueckruf(beiAenderung, schritt.betrag);               // ab jetzt gilt dieser Betrag, auch wenn die Seite zugeht
    infoSetzen("Das Licht läuft aus …");
    await auslaufen(!schritt.gewonnen);
    if (fertig) return;                                   // zwischendurch zerstört

    if (schritt.gewonnen) {
      stufe = schritt.stufe;
      phase = schritt.oben ? "ende" : "wartet";
      anzeigen();
      zeilen[stufe].classList.add("getroffen", "neu");
      rueckruf(beiErgebnis, { art: "auf", betrag: schritt.betrag });
      if (schritt.oben) {
        klingen(klangGewinn, 3);                          // Fanfare ganz oben
        infoSetzen("Oberste Stufe erreicht! Dein Gewinn wird automatisch gesammelt.");
        endeNachPause({ betrag: schritt.betrag, grund: "oben" }, 1800);
        return;
      }
      klingen(klangGewinn, 1);
      infoSetzen("Eine Stufe höher! Weiter riskieren oder sammeln?");
      bereitAb = performance.now() + 250;
      knoepfeSchalten(true);
      blinkStarten();
      return;
    }

    // Absturz
    nullZeile.classList.add("getroffen");
    zeilen[stufe].classList.add("faellt");
    wurzel.classList.add("absturz");
    klingen(klangAbsturz);
    infoSetzen("Absturz! Der Gewinn ist weg.");
    rueckruf(beiErgebnis, { art: "ab", betrag: 0 });
    endeNachPause({ betrag: 0, grund: "absturz" }, 1300);
  }

  /** Tastatur: Leertaste riskiert, S sammelt (Esc behandelt das Overlay selbst). */
  function taste(e) {
    if (tasteIgnorieren(e)) return;
    if (e.key === " ") {
      if (tasteAufBedienelement(e)) return;               // dort löst die Leertaste den Knopf selbst aus
      e.preventDefault();                                 // Seite nicht scrollen
      riskieren();
    } else if (e.key === "s" || e.key === "S") {
      sammeln();
    }
  }

  // ----- Start -----
  anzeigen();
  if (vorschau) {
    infoSetzen("");
  } else {
    infoSetzen("Riskieren: 50 % eine Stufe höher, 50 % Absturz auf 0.");
    if (tastatur) document.addEventListener("keydown", taste);
    blinkStarten();
  }

  return {
    element: wurzel,
    ende,
    riskieren,
    sammeln,
    zerstoeren() {
      fertig = true;
      aufraeumen();
    },
    phase: () => phase,
    betrag: () => stufen[stufe],
    stufen: () => [...stufen],
  };
}

/* ============================================================
   TEIL 4: ROT/SCHWARZ (KARTENRISIKO) ALS KOMPONENTE
   ------------------------------------------------------------
   Eine verdeckte Karte, zwei Knöpfe ROT und SCHWARZ. Gleiche Rückrufe und
   gleiche Rückgabe wie leiterBauen(): { element, ende, tippen, sammeln,
   zerstoeren, phase, betrag }.
   ============================================================ */

export function kartenBauen({
  betrag,
  maxBetrag = Infinity,
  zufall = Math.random,
  beiAenderung = () => {},
  beiErgebnis = () => {},
  tastatur = true,
  sperreMs = SPERRE_MS,
} = {}) {
  const reduziert = bewegungReduziert();
  let aktuell = betrag;                // der Betrag, der gerade sicher ist
  let phase = "wartet";                // "wartet" | "ziehen" | "ende"
  let fertig = false;
  let endeTimer = 0;
  let bereitAb = performance.now() + sperreMs;
  let endeAufloesen = () => {};
  let endeSofort = () => {};
  const ende = new Promise((aufloesen) => { endeAufloesen = aufloesen; });
  const verlauf = [];                  // Farben der bisherigen Karten (kleine Punkte)

  // ----- Aufbau: Szene -> Karte (dreht sich) -> zwei Flächen -----
  const wurzel = el("div", "rk-karten");
  const szene = el("div", "rk-karte-szene");
  const karte = el("div", "rk-karte");
  const hinten = el("div", "rk-flaeche hinten");
  const vorne = el("div", "rk-flaeche vorne");
  const eckeOben = el("div", "rk-ecke oben");
  const eckeUnten = el("div", "rk-ecke unten");
  const mitte = el("div", "rk-mitte");
  for (const ecke of [eckeOben, eckeUnten]) ecke.append(el("span", "rk-ecke-wert"), el("span", "rk-ecke-symbol"));
  vorne.append(eckeOben, mitte, eckeUnten);
  karte.append(hinten, vorne);
  szene.append(karte);
  szene.setAttribute("role", "img");
  szene.setAttribute("aria-label", "Verdeckte Karte");

  const verlaufElement = el("div", "rk-verlauf");
  verlaufElement.setAttribute("aria-hidden", "true");
  const info = el("p", "rk-info");
  info.setAttribute("aria-live", "polite");

  const aktionen = el("div", "rk-aktionen");
  const rotKnopf = knopf("ROT", "knopf rk-rot", () => tippen("rot"));
  const schwarzKnopf = knopf("SCHWARZ", "knopf rk-schwarz", () => tippen("schwarz"));
  const sammelnKnopf = knopf("Sammeln", "knopf primaer rk-sammeln", () => sammeln());
  rotKnopf.setAttribute("aria-keyshortcuts", "ArrowLeft");
  schwarzKnopf.setAttribute("aria-keyshortcuts", "ArrowRight");
  sammelnKnopf.setAttribute("aria-keyshortcuts", "S");
  aktionen.append(rotKnopf, schwarzKnopf, sammelnKnopf);
  wurzel.append(szene, verlaufElement, info, aktionen);

  function infoSetzen(text) {
    info.textContent = text;
  }

  function knoepfeSchalten(an) {
    rotKnopf.disabled = !an;
    schwarzKnopf.disabled = !an;
    sammelnKnopf.disabled = !an;
  }

  function wartetInfo() {
    infoSetzen(`Welche Farbe hat die Karte? Richtig: ${zahlText(aktuell * 2)}, falsch: 0 (je 50 %).`);
  }

  /** Karte vorne beschriften (Wert, Symbol, Farbe). Nur textContent. */
  function vorderseiteFuellen(k) {
    vorne.classList.toggle("rot", k.farbe === "rot");
    for (const ecke of [eckeOben, eckeUnten]) {
      ecke.children[0].textContent = k.wert;
      ecke.children[1].textContent = k.symbol;
    }
    mitte.textContent = k.symbol;
    szene.setAttribute("aria-label", `${k.name}, ${k.farbe === "rot" ? "rot" : "schwarz"}`);
  }

  /** Karte wieder verdecken, OHNE sichtbaren Rückwärts-Flip. */
  function verdecken() {
    karte.classList.add("ohne-uebergang");
    karte.classList.remove("aufgedeckt");
    void karte.offsetWidth;                                // Reflow: Änderung jetzt festschreiben
    karte.classList.remove("ohne-uebergang");
    szene.classList.remove("richtig", "falsch");
    szene.setAttribute("aria-label", "Verdeckte Karte");
  }

  /** Wartet `ms` Millisekunden; bei Abbruch (zerstoeren) läuft nichts mehr weiter. */
  function warte(ms) {
    return new Promise((aufloesen) => { endeTimer = setTimeout(aufloesen, ms); });
  }

  function aufraeumen() {
    clearTimeout(endeTimer);
    document.removeEventListener("keydown", taste);
  }

  function beenden(ergebnis) {
    if (fertig) return;
    fertig = true;
    phase = "ende";
    aufraeumen();
    endeAufloesen(ergebnis);
  }

  function endeNachPause(ergebnis, ms) {
    phase = "ende";
    knoepfeSchalten(false);
    endeTimer = setTimeout(() => beenden(ergebnis), reduziert ? Math.min(ms, 900) : ms);
    endeSofort = () => beenden(ergebnis);
  }

  function sammeln() {
    if (fertig || phase === "ziehen") return;
    if (phase === "ende") {
      endeSofort();
      return;
    }
    beenden({ betrag: aktuell, grund: "sammeln" });
  }

  /** Auf eine Farbe tippen: Karte ziehen (Ergebnis steht sofort fest), aufklappen, auswerten. */
  async function tippen(farbe) {
    if (fertig || phase !== "wartet") return;
    if (performance.now() < bereitAb) return;              // Schutz gegen Doppelklick / gedrückte Taste
    phase = "ziehen";
    knoepfeSchalten(false);

    const schritt = kartenSchritt(aktuell, farbe, maxBetrag, zufall);
    rueckruf(beiAenderung, schritt.betrag);                // ab jetzt gilt dieser Betrag
    infoSetzen(`Du tippst auf ${farbe === "rot" ? "ROT" : "SCHWARZ"} …`);
    vorderseiteFuellen(schritt.karte);
    klingen(klangKartenFlip);
    karte.classList.add("aufgedeckt");                     // der Flip (CSS-Transition); bei reduzierter Bewegung sofort
    await warte(reduziert ? 250 : 750);
    if (fertig) return;

    verlauf.push(schritt.karte.farbe);
    verlaufElement.replaceChildren(...verlauf.slice(-8).map((f) => el("i", f)));

    if (!schritt.richtig) {
      szene.classList.add("falsch");
      klingen(klangAbsturz);
      infoSetzen(`${schritt.karte.name}: falsch getippt. Der Gewinn ist weg.`);
      rueckruf(beiErgebnis, { art: "ab", betrag: 0 });
      endeNachPause({ betrag: 0, grund: "absturz" }, 1300);
      return;
    }

    aktuell = schritt.betrag;
    szene.classList.add("richtig");
    rueckruf(beiErgebnis, { art: "auf", betrag: aktuell });
    if (!schritt.weiter) {
      klingen(klangGewinn, 3);
      infoSetzen(`${schritt.karte.name}: richtig! Das Limit ist erreicht, dein Gewinn wird automatisch gesammelt.`);
      endeNachPause({ betrag: aktuell, grund: "oben" }, 1800);
      return;
    }
    klingen(klangGewinn, 1);
    infoSetzen(`${schritt.karte.name}: richtig! Betrag verdoppelt. Weiter riskieren oder sammeln?`);
    await warte(reduziert ? 300 : 900);
    if (fertig) return;
    verdecken();
    phase = "wartet";
    bereitAb = performance.now() + 250;
    knoepfeSchalten(true);
    wartetInfo();
  }

  /** Tastatur: Pfeil links = ROT, Pfeil rechts = SCHWARZ, S = sammeln. */
  function taste(e) {
    if (tasteIgnorieren(e)) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      tippen("rot");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      tippen("schwarz");
    } else if (e.key === "s" || e.key === "S") {
      sammeln();
    }
  }

  wartetInfo();
  if (tastatur) document.addEventListener("keydown", taste);

  return {
    element: wurzel,
    ende,
    tippen,
    sammeln,
    zerstoeren() {
      fertig = true;
      aufraeumen();
    },
    phase: () => phase,
    betrag: () => aktuell,
  };
}

/* ============================================================
   TEIL 5: DAS OVERLAY FÜR DIE SLOTS
   ------------------------------------------------------------
   risikoAnbieten() legt ein Overlay in die .buehne (position:absolute, wie
   die Gewinnfeier, nie über die ganze Seite) und fragt: "Sammeln oder
   riskieren?". Das Promise wird erst erfüllt, wenn alles vorbei ist, und
   enthält den ENDBETRAG. Die Slots schreiben deshalb einfach:
       const endbetrag = await risikoAnbieten({ buehne, betrag, einsatz, maxBetrag });
   und buchen danach genau diesen Betrag.
   ============================================================ */

/** Es läuft höchstens ein Overlay. Ein neues beendet das alte (es sammelt dabei den sicheren Betrag). */
let aktivesOverlay = null;

/** Wartet ms Millisekunden. */
function pause(ms) {
  return new Promise((aufloesen) => setTimeout(aufloesen, ms));
}

/**
 * Misst die Höhe des Overlays: von der Oberkante der Bühne bis zum Element mit
 * data-gewinnfeier-bis (bei den Slots die Gewinntabelle, die ebenfalls in der
 * Bühne liegt). Fehlt es, deckt das Overlay die ganze Bühne ab. Mindestens 380
 * Pixel, damit die Leiter hineinpasst (sonst scrollt das Overlay).
 */
function hoeheMessen(buehne) {
  const rahmen = buehne.getBoundingClientRect();
  const oben = rahmen.top + buehne.clientTop;
  const bis = buehne.querySelector("[data-gewinnfeier-bis]");
  const hoehe = bis ? bis.getBoundingClientRect().top - oben : buehne.clientHeight;
  return Math.min(Math.max(hoehe, 380), buehne.clientHeight);
}

/**
 * Bietet nach einem Gewinn "Sammeln / Leiter / Rot/Schwarz" an.
 *   buehne        das .buehne-Element, in das das Overlay gelegt wird
 *   betrag        der Gewinn (Brutto-Auszahlung), um den es geht
 *   einsatz       der Einsatz der Runde (nur für die Netto-Anzeige)
 *   maxBetrag     Limit: höher als das wird nie ausgezahlt
 *   zufall        austauschbarer Zufall (Standard Math.random)
 *   timeoutMs     Auto-Sammeln nach so langer Untätigkeit (Standard 20 s)
 *   beiAenderung  (sicherBetrag) SOFORT nach jeder Ziehung: so viel ist jetzt sicher
 * Rückgabe: Promise mit dem ENDBETRAG. Es wird nie abgelehnt.
 */
export async function risikoAnbieten({
  buehne,
  betrag,
  einsatz = 0,
  maxBetrag = Infinity,
  zufall = Math.random,
  timeoutMs = RISIKO_TIMEOUT_MS,
  beiAenderung = () => {},
} = {}) {
  // Nichts zu riskieren (kein Platz mehr unter dem Limit, keine Bühne): der Gewinn bleibt, wie er ist.
  if (!buehne || !risikoMoeglich(betrag, maxBetrag)) return betrag;
  if (aktivesOverlay) aktivesOverlay.abbrechen();

  const stand = { sicher: betrag, wurzel: null };   // teilt den sicheren Betrag mit dem Fehlerfall unten
  try {
    return await overlayLaufen({ buehne, betrag, einsatz, maxBetrag, zufall, timeoutMs, beiAenderung, stand });
  } catch {
    // Ein Fehler im Anzeige-Code darf nie Geld kosten: Dann wird einfach der sichere Betrag gesammelt.
    aktivesOverlay = null;
    stand.wurzel?.remove();
    return stand.sicher;
  }
}

function overlayLaufen({ buehne, betrag, einsatz, maxBetrag, zufall, timeoutMs, beiAenderung, stand }) {
  const reduziert = bewegungReduziert();
  let komponente = null;               // die gewählte Leiter oder Karte
  let beendet = false;
  let abschlussLaeuft = false;
  let automatisch = false;             // true, wenn das Auto-Sammeln ausgelöst hat
  let inaktivTimer = 0;
  let aufloesen = () => {};
  const ergebnisPromise = new Promise((r) => { aufloesen = r; });

  // ----- Aufbau -----
  const wurzel = el("div", "risiko");
  stand.wurzel = wurzel;
  wurzel.style.height = `${hoeheMessen(buehne)}px`;
  const fenster = el("div", "rk-panel");
  fenster.setAttribute("role", "dialog");
  fenster.setAttribute("aria-label", "Gewinn sammeln oder riskieren");
  fenster.tabIndex = -1;

  const kopf = el("p", "rk-kopf", "GEWINN");
  const betragElement = el("p", "rk-betrag", zahlText(betrag));
  const nettoElement = el("p", "rk-netto");
  const frage = el("p", "rk-frage", "Sammeln oder riskieren?");
  const bereich = el("div", "rk-bereich");
  const hinweis = el("p", "rk-klein",
    `Beide Wege: 50 % verdoppeln, 50 % alles verlieren. Ohne Eingabe wird nach ${Math.round(timeoutMs / 1000)} Sekunden automatisch gesammelt.`);

  function kopfAktualisieren(b) {
    betragElement.textContent = zahlText(b);
    nettoElement.textContent = einsatz > 0 ? `Einsatz ${zahlText(einsatz)} · Netto ${nettoText(b - einsatz)}` : "";
  }
  kopfAktualisieren(betrag);

  const sammelnKnopf = knopf("Sammeln", "knopf primaer rk-sammeln", () => sammelnJetzt());
  const leiterKnopf = knopf("Leiter", "knopf", () => modusStarten("leiter"));
  const kartenKnopf = knopf("Rot/Schwarz", "knopf", () => modusStarten("karten"));
  sammelnKnopf.setAttribute("aria-keyshortcuts", "S");
  const wahl = el("div", "rk-aktionen rk-wahl");
  wahl.append(sammelnKnopf, leiterKnopf, kartenKnopf);
  if (!leiterMoeglich(betrag, maxBetrag)) {
    leiterKnopf.disabled = true;
    leiterKnopf.title = "Die Leiter braucht mindestens drei Stufen unter dem Limit.";
    hinweis.textContent += ` Die Leiter geht bei diesem Betrag nicht: Unter dem Limit von ${zahlText(maxBetrag)} passen keine drei Stufen.`;
  }
  bereich.append(wahl);
  fenster.append(kopf, betragElement, nettoElement, frage, bereich, hinweis);
  wurzel.append(fenster);

  // ----- Ablauf -----

  /** Untätigkeit zurücksetzen: Jede Eingabe schiebt das Auto-Sammeln wieder um die volle Zeit nach hinten. */
  function aktivitaet() {
    clearTimeout(inaktivTimer);
    if (beendet || !(timeoutMs > 0)) return;
    inaktivTimer = setTimeout(zeitAbgelaufen, timeoutMs);
  }

  /**
   * Nach Ablauf der Zeit wird automatisch gesammelt: Niemand verliert Geld, nur
   * weil er gerade weggeht. Läuft gerade eine Ziehung oder eine Anzeige, wird
   * die Uhr stattdessen neu gestartet (die beendet sich gleich selbst).
   */
  function zeitAbgelaufen() {
    if (beendet) return;
    if (komponente && komponente.phase() !== "wartet") {
      aktivitaet();
      return;
    }
    automatisch = true;
    sammelnJetzt();
  }

  /** "Sammeln" auf jedem Weg (Knopf, S, Esc, Klick neben das Fenster, Zeitablauf). */
  function sammelnJetzt() {
    if (beendet) return;
    if (komponente) komponente.sammeln();
    else abschliessen({ betrag: stand.sicher, grund: "sammeln" });
  }

  async function abschliessen(ergebnis) {
    if (beendet || abschlussLaeuft) return;
    abschlussLaeuft = true;
    if (automatisch) {
      // Kurz sagen, was passiert ist, bevor das Overlay verschwindet.
      frage.textContent = "Keine Eingabe: Dein Gewinn wurde automatisch gesammelt.";
      await pause(reduziert ? 800 : 1400);
    }
    beenden(ergebnis.betrag);
  }

  function beenden(endbetrag) {
    if (beendet) return;
    beendet = true;
    clearTimeout(inaktivTimer);
    document.removeEventListener("keydown", taste);
    wurzel.removeEventListener("pointerdown", aktivitaet);
    komponente?.zerstoeren();
    if (aktivesOverlay === handle) aktivesOverlay = null;
    wurzel.classList.add("weg");
    setTimeout(() => {
      wurzel.remove();
      aufloesen(endbetrag);
    }, reduziert ? 0 : FADE_MS);
  }

  /** Auswahl durch die Leiter oder die Karte ersetzen. */
  function modusStarten(art) {
    if (beendet || komponente) return;
    const optionen = {
      betrag: stand.sicher,
      maxBetrag,
      zufall,
      beiAenderung: (neu) => {
        stand.sicher = neu;
        rueckruf(beiAenderung, neu);
        aktivitaet();
      },
      beiErgebnis: ({ art: ergebnis, betrag: neu }) => {
        kopfAktualisieren(neu);
        if (ergebnis === "ab") {
          kopf.textContent = "ABSTURZ";
          wurzel.classList.add("verloren");
        }
        aktivitaet();
      },
    };
    komponente = art === "leiter" ? leiterBauen(optionen) : kartenBauen(optionen);
    frage.textContent = art === "leiter" ? "Risikoleiter" : "Rot oder Schwarz?";
    hinweis.remove();
    bereich.replaceChildren(komponente.element);
    fenster.focus({ preventScroll: true });
    komponente.ende.then((ergebnis) => abschliessen(ergebnis));
    aktivitaet();
  }

  /** Esc und S sammeln immer. (Leertaste und Pfeile gehören der Komponente.) */
  function taste(e) {
    aktivitaet();
    if (tasteIgnorieren(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      sammelnJetzt();
    } else if ((e.key === "s" || e.key === "S") && !komponente) {
      sammelnJetzt();
    }
  }

  // Klick auf die abgedunkelte Fläche neben dem Fenster = sammeln (nie versehentlich verlieren).
  wurzel.addEventListener("click", (e) => {
    if (e.target === wurzel) sammelnJetzt();
  });
  wurzel.addEventListener("pointerdown", aktivitaet);
  document.addEventListener("keydown", taste);

  const handle = { abbrechen: () => beenden(stand.sicher) };
  aktivesOverlay = handle;
  buehne.append(wurzel);
  sammelnKnopf.focus({ preventScroll: true });             // sicherste Voreinstellung: Enter/Leertaste sammelt
  fenster.scrollIntoView?.({ block: "nearest", behavior: reduziert ? "auto" : "smooth" });
  aktivitaet();
  return ergebnisPromise;
}
