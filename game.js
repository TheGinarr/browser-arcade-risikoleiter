/* ============================================================
   Risikoleiter · game.js
   ------------------------------------------------------------
   SO FUNKTIONIERT DIESES SPIEL
   1. Die Risikoleiter aus deutschen Spielhallen als eigenes Spiel: Du setzt
      einen Einsatz (Chips 10 / 25 / 50 / 100) und steigst mit AUFSTEIGEN auf
      die Leiter. Dein Einsatz ist sofort im Spiel und bildet die unterste
      Stufe (x1). Darüber liegen x2, x4, x8, x16 und x32.
   2. Auf jeder Stufe hast du zwei Möglichkeiten:
        SAMMELN     Du nimmst den Betrag der aktuellen Stufe mit.
        RISKIEREN   Eine Münze fällt, genau 50 zu 50: Eine Stufe höher
                    (Betrag x2) oder Absturz auf 0.
      Die nächste Stufe und die "0" blinken dabei im Wechsel, bis du
      RISKIEREN drückst. Ganz oben wird automatisch gesammelt.
   3. DIE LEITER SELBST gehört nicht diesem Spiel allein: Sie steckt in
      ../assets/risiko.js (leiterBauen) und wird von den Slots für ihr
      Risiko-Feature mitbenutzt. Dieses Spiel setzt nur Einsatz, Konto,
      Topliste und die Seite drumherum. Die Regeln selbst (Stufen, 50/50-Zug)
      sind dort reine, in Node getestete Funktionen.
   4. GELD: Geld läuft NUR über ../assets/wallet.js (das Konto aller
      Casino-Spiele). Der Einsatz wird beim Aufsteigen abgebucht. Gutgeschrieben
      wird erst am Ende: rundeAbschliessen(einsatz, endbetrag), wobei der
      Endbetrag der gesammelte Betrag oder 0 bei einem Absturz ist. Das Modul
      meldet nach JEDER Ziehung sofort den aktuell sicheren Betrag
      (beiAenderung, Feld runde.sicher). Verlässt man die Seite mittendrin,
      bucht "pagehide" genau diesen Betrag: Ein Absturz bleibt ein Absturz,
      ein gewonnener Schritt bleibt gewonnen, nichts geht durch Weggehen
      verloren und nichts lässt sich durch Neuladen ungeschehen machen.
   5. FAIRNESS: Jeder Schritt ist exakt 50 %. Der Erwartungswert der Runde
      ist deshalb GENAU der Einsatz, egal wann man aufhört (Hausvorteil 0).
      Trotzdem verlieren die meisten: Wer bis ganz oben will, kommt nur mit
      1/32 = 3,125 % an. Dieser Unterschied zwischen Erwartungswert und
      Streuung ist der Lernkern der Seite (siehe Lernbox und Simulation).
   6. Die Topliste zeigt den höchsten NETTO-Gewinn einer Runde (Endbetrag minus
      Einsatz), still eingetragen über stillEintragen() aus ui.js.
   7. Tastatur: Leertaste = RISKIEREN (auf der Leiter) bzw. AUFSTEIGEN (davor),
      S = SAMMELN, Zifferntasten 1 bis 4 wählen den Einsatz.
   ============================================================ */

import { toplisteAnzeigen, stillEintragen } from "./assets/ui.js";
import { lade, speichere, entferne } from "./assets/storage.js";
import {
  STARTGELD,
  kontostand,
  einsatzAbbuchen,
  rundeAbschliessen,
  istPleite,
  pleiteNeustart,
  walletHud,
  walletHudAktualisieren,
} from "./assets/wallet.js";
import { tonKnopf } from "./assets/klang.js";
import { leiterBauen, leiterTabelle, risikoZiehen, RISIKO_FAKTOREN } from "./assets/risiko.js";

const SPIEL = "risikoleiter"; // Schlüssel für storage.js (Topliste und gewählter Einsatz)
const CHIPS = [10, 25, 50, 100]; // erlaubte Einsätze
const MINDESTEINSATZ = CHIPS[0]; // darunter ist man pleite
const NACH_RUNDE_SPERRE_MS = 700; // so lange nach dem Ende startet keine neue Runde (Leertaste-Spammer-Schutz)

/* ============================================================
   TEIL 1: REINE LOGIK (ohne DOM, in Node testbar)
   ============================================================ */

/** Das höchste Vielfache der Leiter (oberste Stufe): x32. */
export const FAKTOR_MAX = RISIKO_FAKTOREN[RISIKO_FAKTOREN.length - 1];

/** Limit für die Leiter einer Runde: Einsatz x 32 (die oberste Stufe). */
export function maxBetragFuer(einsatz) {
  return einsatz * FAKTOR_MAX;
}

/** NETTO einer Runde: Endbetrag minus Einsatz (bei Absturz also minus Einsatz). */
export function nettoBerechnen(einsatz, endbetrag) {
  return endbetrag - einsatz;
}

/**
 * Meldung unter der Leiter nach dem Ende einer Runde: { text, art }.
 *   ergebnis  { betrag, grund } aus dem Modul; grund: "sammeln" | "oben" | "absturz"
 */
export function endMeldung(einsatz, ergebnis) {
  const geld = (n) => n.toLocaleString("de-DE");
  const netto = nettoBerechnen(einsatz, ergebnis.betrag);
  if (ergebnis.grund === "absturz") {
    return { text: `Absturz! Dein Einsatz von ${geld(einsatz)} ist weg.`, art: "falsch" };
  }
  if (ergebnis.grund === "oben") {
    return {
      text: `Ganz oben! ${geld(ergebnis.betrag)} gesammelt, Netto +${geld(netto)}. Das schaffen nur 3,1 % der Aufsteiger.`,
      art: "richtig",
    };
  }
  if (netto === 0)
    return {
      text: `Gesammelt: ${geld(ergebnis.betrag)}, dein Einsatz zurück (Netto ±0).`,
      art: "neutral",
    };
  return { text: `Gesammelt: ${geld(ergebnis.betrag)}, Netto +${geld(netto)}.`, art: "richtig" };
}

/**
 * Lern-Simulation: `runden` Spieler wollen alle bis zur Zielstufe `zielStufe` klettern
 * (1 = x2, 2 = x4 ... 5 = x32) und sammeln dann; stürzt einer ab, ist alles weg.
 * Es zählt der Gewinn in Vielfachen des Einsatzes (Einsatz = 1).
 * Rückgabe: { runden, verloren, geschafft, durchschnitt, anteilVerloren, anteilGeschafft, ziel }
 * Die Schritte benutzen DIESELBE Ziehung wie das Spiel (risikoZiehen), der Zufall ist austauschbar.
 */
export function simulieren(zielStufe, runden, zufall = Math.random) {
  const ziel = RISIKO_FAKTOREN[zielStufe];
  let verloren = 0;
  let summe = 0;
  for (let r = 0; r < runden; r++) {
    let stufe = 0;
    while (stufe < zielStufe && risikoZiehen(zufall)) stufe++;
    if (stufe === zielStufe) summe += ziel;
    else verloren++;
  }
  const geschafft = runden - verloren;
  return {
    runden,
    verloren,
    geschafft,
    ziel,
    durchschnitt: runden > 0 ? summe / runden : 0,
    anteilVerloren: runden > 0 ? verloren / runden : 0,
    anteilGeschafft: runden > 0 ? geschafft / runden : 0,
  };
}

/* ============================================================
   TEIL 2: DAS SPIEL IM BROWSER
   ============================================================ */

function starteSpiel() {
  // ----- Elemente einmal suchen und merken -----
  const halter = document.getElementById("leiter-halter");
  const betragElement = document.getElementById("rl-betrag");
  const nettoElement = document.getElementById("rl-netto");
  const meldungElement = document.getElementById("meldung");
  const gewinnElement = document.getElementById("gewinn");
  const hudLetzter = document.getElementById("hud-letzter");
  const startKnopf = document.getElementById("start");
  const chipKnoepfe = [...document.querySelectorAll("#chips .chip")];
  const toplisteElement = document.getElementById("topliste");
  const resetKnopf = document.getElementById("reset");
  const kopfElement = document.querySelector(".spiel-kopf");

  // ----- Spielzustand -----
  let phase = "bereit"; // "bereit" (Einsatz wählen) | "aufstieg" (Leiter läuft)
  let einsatz = ladeEinsatz(); // gewählter Chip
  let runde = null; // { einsatz, sicher, abgerechnet } während einer Runde; sicher = aktuell SICHERER Betrag
  let leiter = null; // die Leiter-Komponente aus risiko.js
  let sperreBis = 0; // vor diesem Zeitpunkt (performance.now) startet keine neue Runde

  const zahlText = (n) => n.toLocaleString("de-DE");

  // ---------------------------------------------------------
  // Einsatz und Chips
  // ---------------------------------------------------------

  function ladeEinsatz() {
    const gespeichert = lade(SPIEL, "einsatz", 50);
    return CHIPS.includes(gespeichert) ? gespeichert : 50;
  }

  /** Ist der gewählte Chip teurer als das Konto, wird der größte bezahlbare gewählt. */
  function einsatzAnpassen() {
    const stand = kontostand();
    if (einsatz > stand) {
      einsatz = [...CHIPS].reverse().find((c) => c <= stand) ?? MINDESTEINSATZ;
    }
  }

  function steuerungAktualisieren() {
    const stand = kontostand();
    const bereit = phase === "bereit";
    for (const chip of chipKnoepfe) {
      const wert = Number(chip.dataset.wert);
      chip.disabled = !bereit || wert > stand;
      chip.setAttribute("aria-pressed", String(wert === einsatz));
    }
    startKnopf.disabled = !bereit || einsatz > stand;
    startKnopf.hidden = !bereit;
    document.getElementById("chips").hidden = !bereit;
    resetKnopf.disabled = !bereit;
  }

  function einsatzWaehlen(wert) {
    if (phase !== "bereit" || !CHIPS.includes(wert) || wert > kontostand()) return;
    einsatz = wert;
    speichere(SPIEL, "einsatz", wert);
    steuerungAktualisieren();
    vorschauZeigen();
  }

  // ---------------------------------------------------------
  // Anzeigen
  // ---------------------------------------------------------

  function meldungSetzen(text, art = "neutral") {
    meldungElement.textContent = text;
    meldungElement.dataset.art = art;
  }

  /** "+120" / "−50" / "±0" über der Meldung; null leert die Anzeige. */
  function gewinnSetzen(netto) {
    gewinnElement.className = "gewinn-anzeige";
    if (netto === null) {
      gewinnElement.textContent = "";
    } else if (netto > 0) {
      gewinnElement.textContent = `+${zahlText(netto)}`;
      gewinnElement.classList.add("plus");
    } else if (netto < 0) {
      gewinnElement.textContent = `−${zahlText(-netto)}`; // echtes Minuszeichen (U+2212)
      gewinnElement.classList.add("minus");
    } else {
      gewinnElement.textContent = "±0";
    }
  }

  /** "+120" / "−50" / "±0" (echtes Minuszeichen). */
  function nettoText(n) {
    return n > 0 ? `+${zahlText(n)}` : n < 0 ? `−${zahlText(-n)}` : "±0";
  }

  /** Großer Betrag links neben der Leiter und die Netto-Zeile darunter. */
  function betragAnzeigen(betrag, gesetzt, verloren = false) {
    betragElement.textContent = zahlText(betrag);
    betragElement.classList.toggle("verloren", verloren);
    nettoElement.textContent = `Einsatz ${zahlText(gesetzt)} · Netto ${nettoText(betrag - gesetzt)}`;
  }

  function seiteAktualisieren() {
    toplisteAnzeigen(toplisteElement, SPIEL, (p) => `+${zahlText(p)}`);
  }

  /** Vor dem Start: die Leiter mit den Beträgen des gewählten Einsatzes, nur zum Anschauen. */
  function vorschauZeigen() {
    runde = null;
    const vorschau = leiterBauen({
      betrag: einsatz,
      maxBetrag: maxBetragFuer(einsatz),
      vorschau: true,
    });
    halter.replaceChildren(vorschau.element);
    betragElement.textContent = "–";
    betragElement.classList.remove("verloren");
    nettoElement.textContent = `Einsatz ${zahlText(einsatz)}`;
  }

  // ---------------------------------------------------------
  // Abrechnung (Geld)
  // ---------------------------------------------------------

  /**
   * Schreibt das Ende der laufenden Runde gut: Einsatz gegen den sicheren Betrag.
   * Normalerweise nach dem Ende der Leiter, aber auch bei "pagehide" (Seite wird
   * verlassen). Das Flag "abgerechnet" verhindert doppelte Gutschrift.
   */
  function rundeAbrechnen(endbetrag) {
    if (!runde || runde.abgerechnet) return;
    runde.abgerechnet = true;
    rundeAbschliessen(runde.einsatz, endbetrag ?? runde.sicher);
  }
  window.addEventListener("pagehide", () => rundeAbrechnen());

  // ---------------------------------------------------------
  // Eine Runde
  // ---------------------------------------------------------

  function aufsteigen() {
    if (phase !== "bereit" || performance.now() < sperreBis) return;
    einsatzAnpassen();
    if (!einsatzAbbuchen(einsatz)) {
      meldungSetzen("Dafür reicht dein Spielgeld nicht. Wähle einen kleineren Einsatz.", "falsch");
      steuerungAktualisieren();
      return;
    }
    phase = "aufstieg";
    runde = { einsatz, sicher: einsatz, abgerechnet: false }; // der Einsatz ist die unterste Stufe: sofort im Spiel
    walletHudAktualisieren(); // der Einsatz verlässt sichtbar das Konto
    gewinnSetzen(null);
    steuerungAktualisieren();
    betragAnzeigen(einsatz, einsatz);
    meldungSetzen("Du steigst auf. Sammeln oder riskieren? Jeder Schritt ist 50 zu 50.");

    // Dieselbe Leiter wie im Risiko-Overlay der Slots: Stufen x1 bis x32 vom Einsatz.
    leiter = leiterBauen({
      betrag: einsatz,
      maxBetrag: maxBetragFuer(einsatz),
      // SOFORT nach jeder Ziehung: so viel ist jetzt sicher (auch mitten in der Blink-Animation).
      beiAenderung: (sicher) => {
        if (runde) runde.sicher = sicher;
      },
      // Wenn die Animation gelandet ist: Anzeige links nachziehen.
      beiErgebnis: ({ art, betrag }) =>
        betragAnzeigen(betrag, runde ? runde.einsatz : einsatz, art === "ab"),
    });
    halter.replaceChildren(leiter.element);
    leiter.ende.then(rundeBeenden);
  }

  /** Ende der Leiter: sammeln, ganz oben oder Absturz. Hier wird gebucht. */
  function rundeBeenden(ergebnis) {
    if (!runde) return;
    const gesetzt = runde.einsatz;
    rundeAbrechnen(ergebnis.betrag);
    const netto = nettoBerechnen(gesetzt, ergebnis.betrag);
    betragAnzeigen(ergebnis.betrag, gesetzt, ergebnis.grund === "absturz");
    runde = null;
    leiter = null;
    walletHudAktualisieren();
    gewinnSetzen(netto);
    hudLetzter.textContent = nettoText(netto);
    hudLetzter.className = `wert ${netto > 0 ? "plus" : netto < 0 ? "minus" : ""}`;
    const meldung = endMeldung(gesetzt, ergebnis);
    meldungSetzen(meldung.text, meldung.art);

    // Topliste: der höchste Netto-Gewinn einer Runde, STILL eingetragen (kein Dialog)
    if (netto > 0 && stillEintragen(SPIEL, netto) !== null) seiteAktualisieren();

    phase = "bereit";
    sperreBis = performance.now() + NACH_RUNDE_SPERRE_MS;
    einsatzAnpassen();
    steuerungAktualisieren();
    if (istPleite(MINDESTEINSATZ)) pleiteDialogZeigen();
  }

  // ---------------------------------------------------------
  // Pleite-Dialog
  // ---------------------------------------------------------

  /** "Pleite! Neues Startgeld." – lässt sich nur per Knopf schließen. */
  function pleiteDialogZeigen() {
    if (document.getElementById("pleite-dialog")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "spiel-dialog";
    dialog.id = "pleite-dialog";
    // Nur feste Texte im HTML; die Zahl kommt per textContent
    dialog.innerHTML = `
      <h2>Pleite!</h2>
      <p>Dein Spielgeld ist aufgebraucht. Du bekommst neues Startgeld:</p>
      <p class="gross"></p>
      <div class="aktionen">
        <button class="knopf primaer" data-rolle="neu">Neues Startgeld</button>
        
      </div>`;
    dialog.querySelector(".gross").textContent = STARTGELD.toLocaleString("de-DE");
    dialog.querySelector('[data-rolle="neu"]').addEventListener("click", () => {
      pleiteNeustart();
      walletHudAktualisieren();
      dialog.close();
      dialog.remove();
      einsatzAnpassen();
      steuerungAktualisieren();
      vorschauZeigen();
      meldungSetzen("Neues Startgeld ist da. Viel Glück!");
    });
    // Esc würde den Dialog ohne Neustart schließen -> verhindern
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector("button")?.focus();
  }

  // ---------------------------------------------------------
  // Eingabe
  // ---------------------------------------------------------
  startKnopf.addEventListener("click", aufsteigen);
  for (const chip of chipKnoepfe) {
    chip.addEventListener("click", (e) => {
      einsatzWaehlen(Number(chip.dataset.wert));
      // Mit Maus/Finger angeklickt: Fokus loslassen, damit die Leertaste danach aufsteigt.
      if (e.detail > 0) chip.blur();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return; // Browser-Kürzel nicht stören, Dauerdruck ignorieren
    if (document.querySelector("dialog[open]")) return; // Dialog offen -> Tasten gehören ihm
    const tag = e.target instanceof Element ? e.target.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (phase !== "bereit") return; // auf der Leiter hören die Tasten dem Modul (Leertaste, S)

    if (e.key === " ") {
      // Auf einem fokussierten Knopf/Link/Aufklapper macht die Leertaste schon etwas (anklicken): nicht doppelt auslösen.
      if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return;
      e.preventDefault(); // Seite nicht scrollen
      aufsteigen();
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= CHIPS.length) {
      einsatzWaehlen(CHIPS[Number(e.key) - 1]);
    }
  });

  // Nur die Topliste zurücksetzen (nicht den gemerkten Einsatz und nie das Spielgeld).
  resetKnopf.addEventListener("click", () => {
    if (phase !== "bereit") return;
    entferne(SPIEL, "topliste");
    seiteAktualisieren();
  });

  simulationAufbauen();

  // ----- Start -----
  walletHud(document.getElementById("wallet-hud"));
  tonKnopf(kopfElement); // Ton an/aus, gilt für alle Casino-Spiele
  einsatzAnpassen();
  steuerungAktualisieren();
  vorschauZeigen();
  seiteAktualisieren();
  tabelleFuellen();
  if (istPleite(MINDESTEINSATZ)) pleiteDialogZeigen();
}

/* ------------------------------------------------------------
   Lernbox: Tabelle und Simulation. Die Werte kommen aus den
   reinen Funktionen (leiterTabelle, simulieren), damit Text
   und Spiel nie auseinanderlaufen. (textContent statt innerHTML.)
   ------------------------------------------------------------ */

function zeileBauen(zellen, betont = false) {
  const tr = document.createElement("tr");
  if (betont) tr.className = "betont";
  zellen.forEach((text, i) => {
    const zelle = document.createElement(i === 0 ? "th" : "td");
    if (i === 0) zelle.scope = "row";
    zelle.textContent = text;
    tr.append(zelle);
  });
  return tr;
}

/** "3,13 %" – deutsches Komma, höchstens zwei Nachkommastellen. */
function prozent(anteil) {
  return `${(anteil * 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
}

function tabelleFuellen() {
  const koerper = document.getElementById("leiter-tabelle");
  // Einsatz = 1: Alle Beträge sind direkt die Vielfachen (x1 ... x32).
  for (const zeile of leiterTabelle(1)) {
    koerper.append(
      zeileBauen(
        [
          zeile.stufe === 0 ? "Sofort sammeln (x1)" : `Bis x${zeile.faktor} klettern`,
          prozent(zeile.chance),
          prozent(zeile.verlust),
          `${zeile.erwartung.toLocaleString("de-DE", { maximumFractionDigits: 2 })} × Einsatz`,
          `${zeile.streuung.toLocaleString("de-DE", { maximumFractionDigits: 2 })} × Einsatz`,
        ],
        zeile.stufe === RISIKO_FAKTOREN.length - 1,
      ),
    );
  }
}

/** Die Mitmach-Simulation in der Lernbox: 10.000 Aufsteiger, alle mit demselben Ziel. */
function simulationAufbauen() {
  const auswahl = document.getElementById("sim-ziel");
  const knopf = document.getElementById("sim-start");
  const ausgabe = document.getElementById("sim-ergebnis");
  RISIKO_FAKTOREN.forEach((faktor, i) => {
    if (i === 0) return; // x1 wäre sofort sammeln: nichts zu simulieren
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `x${faktor}`;
    if (i === RISIKO_FAKTOREN.length - 1) option.selected = true;
    auswahl.append(option);
  });
  knopf.addEventListener("click", () => {
    const stufe = Number(auswahl.value);
    const e = simulieren(stufe, 10000);
    ausgabe.replaceChildren();
    const zeile1 = document.createElement("span");
    zeile1.append(
      "Von 10.000 Aufsteigern mit dem Ziel ",
      Object.assign(document.createElement("strong"), { textContent: `x${e.ziel}` }),
      ` verloren ${e.verloren.toLocaleString("de-DE")} alles (${prozent(e.anteilVerloren)}), nur ${e.geschafft.toLocaleString("de-DE")} kamen an (${prozent(e.anteilGeschafft)}). `,
    );
    const zeile2 = document.createElement("span");
    zeile2.append(
      "Im Durchschnitt hat jeder ",
      Object.assign(document.createElement("strong"), {
        textContent: `${e.durchschnitt.toLocaleString("de-DE", { maximumFractionDigits: 2 })} × Einsatz`,
      }),
      " zurückbekommen. Fair gerechnet wäre es genau 1.",
    );
    ausgabe.append(zeile1, zeile2);
  });
}

// Nur im Browser starten. In Node (Tests) gibt es kein "document" –
// dort werden nur die reinen Funktionen oben importiert.
if (typeof document !== "undefined") {
  starteSpiel();
}
