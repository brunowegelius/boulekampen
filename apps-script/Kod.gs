/**
 * Boulekampen 2026 — platstak för anmälan
 * ───────────────────────────────────────
 * Gör två saker:
 *   1. Stänger formuläret automatiskt när CAP lag har anmält sig.
 *      Det är den enda platsen taket går att hålla på riktigt — sajten är
 *      statisk, och allt som räknas i webbläsaren går att kringgå.
 *   2. Svarar med hur många platser som är kvar, så sajten kan visa det
 *      och sluta ta emot i stället för att låtsas att en anmälan gick in.
 *
 * ── Installation ──────────────────────────────────────────────────────
 *  1. Öppna formuläret → ⋮ (uppe till höger) → Skriptredigerare
 *  2. Ersätt allt i Kod.gs med den här filen. Spara.
 *  3. Kör funktionen  installTrigger  en gång. Google frågar efter
 *     behörighet — godkänn. (Välj funktionen i rullistan → Kör.)
 *  4. Distribuera → Ny distribution → kugghjulet → Webbapp
 *        Beskrivning:      Platsräknare
 *        Kör som:          Jag
 *        Vem har åtkomst:  Alla
 *     Kopiera webbapp-URL:en (slutar på /exec).
 *  5. Klistra in URL:en i COUNTER_URL överst i anmal.html och index.html
 *     på sajten. Är den tom är räknaren avstängd och sidan beter sig
 *     precis som förut.
 *
 * ── Bra att veta ──────────────────────────────────────────────────────
 *  • Triggern kör EFTER att svaret sparats. Två personer som trycker
 *    skicka i exakt samma sekund kan därför båda komma in på sista
 *    platsen. Kolla antalet svar vid taket och hantera ett eventuellt
 *    överskott manuellt.
 *  • Ändrar du CAP måste du köra  syncNow  för att öppna/stänga direkt.
 *  • Hoppar ett lag av: kör  reopenForm  så tar formuläret emot igen.
 */

const CAP = 16;

function form_() {
  return FormApp.getActiveForm();
}

/** Stänger formuläret när taket är nått. Kopplas på via installTrigger. */
function onFormSubmitHandler() {
  syncNow();
}

/** Öppnar/stänger formuläret så det matchar antalet svar just nu. */
function syncNow() {
  const form = form_();
  const taken = form.getResponses().length;

  if (taken >= CAP && form.isAcceptingResponses()) {
    form.setCustomClosedMessage(
      'Boulekampen 2026 är fullbokat — alla ' + CAP + ' platser är tagna.'
    );
    form.setAcceptingResponses(false);
  } else if (taken < CAP && !form.isAcceptingResponses()) {
    form.setAcceptingResponses(true);
  }

  Logger.log(taken + ' av ' + CAP + ' platser tagna. Öppet: ' + form.isAcceptingResponses());
  return taken;
}

/**
 * Sajtens platsräknare.
 * Svarar med JSONP om ?callback= skickas med, annars vanlig JSON.
 * JSONP används från sajten för att slippa CORS-strulet som Apps Scripts
 * omdirigering till googleusercontent.com annars ger.
 */
function doGet(e) {
  const form = form_();
  const taken = form.getResponses().length;
  const body = JSON.stringify({
    cap: CAP,
    taken: taken,
    left: Math.max(0, CAP - taken),
    open: form.isAcceptingResponses() && taken < CAP
  });

  const cb = e && e.parameter && e.parameter.callback;
  if (cb && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cb)) {
    return ContentService
      .createTextOutput(cb + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

/** Körs en gång manuellt: kopplar triggern och synkar läget direkt. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onFormSubmitHandler') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmitHandler').forForm(form_()).onFormSubmit().create();
  Logger.log('Trigger installerad.');
  syncNow();
}

/** Öppna formuläret igen, t.ex. om ett lag hoppar av. */
function reopenForm() {
  form_().setAcceptingResponses(true);
  Logger.log('Öppnat igen. ' + form_().getResponses().length + ' av ' + CAP + ' platser tagna.');
}
