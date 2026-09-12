/**
 * Vestyr contact form — production behaviour.
 *
 * Posts the form to the same-origin Worker at /api/contact. No CORS, no third
 * party. Turnstile renders explicitly so the widget only appears once the
 * script has actually loaded; if it never loads the form still submits and the
 * Worker rejects it server-side, which is the check that matters.
 */
(function () {
  "use strict";

  var SITE_KEY = window.VESTYR_TURNSTILE_SITE_KEY || "";
  var form = document.getElementById("contact-form");
  if (!form) return;

  var submit = document.getElementById("contact-submit");
  var status = document.getElementById("contact-status");
  var slot = document.getElementById("turnstile");
  var submitLabel = submit ? submit.textContent : "Send to Josh";
  var widgetId = null;
  var sending = false;

  function setStatus(kind, text) {
    if (!status) return;
    status.className = "formstatus" + (kind ? " is-" + kind : "");
    status.textContent = text;
    status.hidden = !text;
  }

  function setBusy(on) {
    sending = on;
    if (!submit) return;
    submit.disabled = on;
    submit.setAttribute("aria-busy", on ? "true" : "false");
    submit.textContent = on ? "Sending…" : submitLabel;
  }

  var PLACEHOLDER = "TURNSTILE_SITE_KEY_PLACEHOLDER";

  function renderWidget() {
    if (widgetId !== null) return;
    if (!slot || !SITE_KEY || SITE_KEY === PLACEHOLDER) return;
    if (!window.turnstile || typeof window.turnstile.render !== "function") return;
    try {
      widgetId = window.turnstile.render(slot, {
        sitekey: SITE_KEY,
        theme: "dark",
        size: "flexible",
        action: "contact"
      });
    } catch (e) {
      // A bad or unconfigured key must not take the rest of the page down.
      widgetId = null;
    }
  }

  // The inline bootstrap in index.html owns window.vestyrTurnstileReady, so the
  // callback exists before api.js runs whichever order the scripts settle in.
  window.__vestyrRenderTurnstile = renderWidget;
  if (window.__vestyrTurnstileLoaded) renderWidget();

  function token() {
    if (widgetId !== null && window.turnstile) return window.turnstile.getResponse(widgetId) || "";
    var field = form.querySelector('[name="cf-turnstile-response"]');
    return field ? field.value : "";
  }

  function resetChallenge() {
    if (widgetId !== null && window.turnstile) {
      try { window.turnstile.reset(widgetId); } catch (e) { /* widget already gone */ }
    }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (sending) return;

    var data = new FormData(form);
    var payload = {
      name: String(data.get("name") || "").trim(),
      email: String(data.get("email") || "").trim(),
      company: String(data.get("company") || "").trim(),
      message: String(data.get("message") || "").trim(),
      website: String(data.get("website") || ""),
      diagnostic: String(data.get("diagnostic_result") || ""),
      turnstileToken: token()
    };

    if (!payload.name || !payload.email || !payload.message) {
      setStatus("err", "Please add your name, email and a short message.");
      return;
    }

    setBusy(true);
    setStatus("", "");

    fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () { return { success: false }; });
      })
      .then(function (body) {
        if (body && body.success) {
          form.reset();
          resetChallenge();
          var carry = document.getElementById("diag-carry");
          if (carry) carry.hidden = true;
          var hidden = document.getElementById("diag-payload");
          if (hidden) hidden.value = "";
          setStatus("ok", "Thanks — your message is on its way. I’ll get back to you shortly.");
        } else {
          resetChallenge();
          setStatus("err", (body && body.error) || "Unable to send message. Please try again.");
        }
      })
      .catch(function () {
        resetChallenge();
        setStatus("err", "Unable to send message. Please try again, or email me directly.");
      })
      .then(function () {
        setBusy(false);
      });
  });
})();
