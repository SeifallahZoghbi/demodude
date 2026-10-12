// App-side bridge for the stub bundle: implements docs/protocol.md in plain JS so
// the service can be developed without a real app. Three screens, a fake cursor,
// four moves with real DOM changes, and the stop/reset messages.
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var demoOrigin = params.get("demoOrigin");
  if (!demoOrigin) {
    // Opened directly, not inside the demo service: run as a plain page.
    initApp();
    return;
  }

  var COST = { "MDB-01": 1860000, "EMDB-01": 742000 };
  var INITIAL = { screen: "projects", projectName: "Al-Marsa Business Park — Phase 2", selectedBoard: null, markupPercent: 18 };
  var state = clone(INITIAL);
  var stopFlag = false;
  var cursor;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function post(msg) { window.parent.postMessage(msg, demoOrigin); }

  function sendState() { post({ type: "demo:state", state: clone(state) }); }

  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

  // ---- app behaviour ------------------------------------------------------

  function initApp() {
    document.querySelectorAll("[data-nav]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showScreen(btn.getAttribute("data-nav"));
        if (demoOrigin) post({ type: "demo:userAction", description: "opened the " + btn.getAttribute("data-nav") + " screen" });
      });
    });
    document.querySelectorAll("[data-board]").forEach(function (row) {
      row.addEventListener("click", function () { selectBoard(row.getAttribute("data-board")); });
    });
    var markup = document.getElementById("markup");
    markup.addEventListener("input", function () { setMarkup(Number(markup.value)); });
    renderTotals();
  }

  function showScreen(name) {
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.toggle("active", s.id === "screen-" + name); });
    document.querySelectorAll("[data-nav]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-nav") === name); });
    if (state.screen !== name) {
      state.screen = name;
      if (demoOrigin) sendState();
    }
  }

  function selectBoard(tag) {
    document.querySelectorAll("[data-board]").forEach(function (r) { r.classList.toggle("selected", r.getAttribute("data-board") === tag); });
    state.selectedBoard = tag;
    if (demoOrigin) sendState();
  }

  function setMarkup(pct) {
    if (!isFinite(pct)) return;
    pct = Math.max(0, Math.min(60, pct));
    state.markupPercent = pct;
    document.getElementById("markup").value = String(pct);
    renderTotals();
    if (demoOrigin) sendState();
  }

  function renderTotals() {
    var cost = COST["MDB-01"] + COST["EMDB-01"];
    var sell = cost * (1 + state.markupPercent / 100);
    document.getElementById("t-cost").textContent = "EGP " + fmt(cost);
    document.getElementById("t-pct").textContent = String(state.markupPercent);
    document.getElementById("t-sell").textContent = "EGP " + fmt(sell);
    document.getElementById("t-vat").textContent = "EGP " + fmt(sell * 1.14);
  }

  function totalsLine() {
    var cost = COST["MDB-01"] + COST["EMDB-01"];
    var sell = cost * (1 + state.markupPercent / 100);
    return "Markup is " + state.markupPercent + "%, selling total EGP " + fmt(sell) + ".";
  }

  // ---- fake cursor ----------------------------------------------------------

  function makeCursor() {
    var el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;left:0;top:0;width:20px;height:24px;z-index:2147483647;pointer-events:none;" +
      "transform:translate(40px,40px);transition:transform 450ms cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";
    el.innerHTML = '<svg width="20" height="24" viewBox="0 0 20 24"><path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.5 20.5 L9.5 14 L16 14 Z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    document.body.appendChild(el);
    return el;
  }

  function moveCursorTo(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    var r = el.getBoundingClientRect();
    cursor.style.transform = "translate(" + (r.left + Math.min(r.width / 2, 80)) + "px," + (r.top + r.height / 2) + "px)";
    el.style.outline = "2px solid #2563eb";
    el.style.outlineOffset = "4px";
    el.style.borderRadius = "6px";
    setTimeout(function () { el.style.outline = ""; el.style.outlineOffset = ""; }, 1200);
  }

  function ripple() {
    var m = /translate\(([\d.]+)px,\s*([\d.]+)px\)/.exec(cursor.style.transform) || [0, 0, 0];
    var r = document.createElement("div");
    r.style.cssText = "position:fixed;left:" + m[1] + "px;top:" + m[2] + "px;width:12px;height:12px;margin:-6px 0 0 -6px;" +
      "border-radius:50%;border:2px solid #2563eb;z-index:2147483646;pointer-events:none;transition:all 350ms ease-out;opacity:1";
    document.body.appendChild(r);
    requestAnimationFrame(function () { r.style.transform = "scale(3)"; r.style.opacity = "0"; });
    setTimeout(function () { r.remove(); }, 400);
  }

  function wait(ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { stopFlag ? reject(new Error("stopped")) : resolve(); }, ms);
      if (stopFlag) { clearTimeout(t); reject(new Error("stopped")); }
    });
  }

  function target(name) {
    var el = document.querySelector('.screen.active [data-demo="' + name + '"]');
    if (!el) throw new Error("No element for target '" + name + "' on the " + state.screen + " screen");
    return el;
  }

  // ---- moves ------------------------------------------------------------------

  var moves = {
    go_to_screen: function (args) {
      var name = args.screen;
      if (!document.getElementById("screen-" + name)) throw new Error("Unknown screen '" + name + "'");
      if (state.screen === name) return Promise.resolve("Already on " + name + ".");
      var btn = document.querySelector('[data-nav="' + name + '"]');
      moveCursorTo(btn);
      return wait(500).then(function () {
        ripple();
        showScreen(name);
        return wait(400);
      }).then(function () {
        return "Now on " + name + "." + (name === "pricing" ? " " + totalsLine() : "");
      });
    },
    point_at: function (args) {
      var el = target(args.target);
      moveCursorTo(el);
      return wait(900).then(function () { return "Pointing at " + args.target + " on the " + state.screen + " screen."; });
    },
    set_markup: function (args) {
      if (state.screen !== "pricing") throw new Error("set_markup only works on the pricing screen");
      var inputEl = target("markup_input");
      moveCursorTo(inputEl);
      return wait(500).then(function () {
        ripple();
        inputEl.focus();
        return wait(250);
      }).then(function () {
        setMarkup(Number(args.percent));
        return wait(400);
      }).then(function () { return totalsLine(); });
    },
    reset_demo: function () {
      reset();
      return wait(300).then(function () { return "Demo reset. Now on projects."; });
    },
  };

  function reset() {
    stopFlag = false;
    state = clone(INITIAL);
    document.querySelectorAll("[data-board]").forEach(function (r) { r.classList.remove("selected"); });
    document.getElementById("markup").value = "18";
    renderTotals();
    showScreen("projects");
    sendState();
  }

  function runMove(msg) {
    stopFlag = false;
    var fn = moves[msg.name];
    var p;
    try {
      p = fn ? fn(msg.args || {}) : Promise.reject(new Error("Unknown move '" + msg.name + "'"));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(function (result) {
      post({ type: "demo:moveResult", id: msg.id, ok: true, result: String(result) });
    }, function (err) {
      var text = err && err.message ? err.message : String(err);
      post({ type: "demo:moveResult", id: msg.id, ok: false, error: text });
    });
  }

  // ---- bridge -------------------------------------------------------------

  window.addEventListener("message", function (event) {
    if (event.origin !== demoOrigin || event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "demo:move": runMove(msg); break;
      case "demo:stop": stopFlag = true; break;
      case "demo:reset": reset(); break;
    }
  });

  initApp();
  cursor = makeCursor();
  post({ type: "demo:ready", app: "_stub", moves: Object.keys(moves), state: clone(state) });
})();
