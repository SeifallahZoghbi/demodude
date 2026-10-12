// Panel client: owns the session, streams turns over SSE, and relays moves to
// the app iframe via postMessage (docs/protocol.md). Plain browser JS, no build.
(function () {
  "use strict";

  var config = JSON.parse(document.getElementById("demo-config").textContent);
  var base = config.basePath || "";
  var api = base + "/api";

  var frame = document.getElementById("app-frame");
  var transcript = document.getElementById("transcript");
  var statusEl = document.getElementById("status");
  var input = document.getElementById("input");
  var composer = document.getElementById("composer");
  var btnPause = document.getElementById("btn-pause");
  var btnContinue = document.getElementById("btn-continue");
  var btnRestart = document.getElementById("btn-restart");

  // Long enough for a staged "processing" move (the protocol allows up to 30 s for
  // those) plus a slow machine; a real hang is still caught and reported to the guide.
  var MOVE_TIMEOUT_MS = 45000;
  var READY_TIMEOUT_MS = 4000;

  var state = {
    sessionId: null,
    phase: "idle", // idle | streaming | moving | paused | dead
    controller: null, // AbortController for the SSE fetch in flight
    pendingMove: null, // move handed to the app, awaiting demo:moveResult
    heldResult: null, // moveResult kept back after a pause, sent with the next text
    queuedText: null, // text typed while a move was still winding down
    appState: null, // latest demo:state payload
    ready: false,
    moveTimer: null,
    currentBubble: null,
  };

  // ---- transcript helpers --------------------------------------------------

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    el.textContent = text;
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
  }

  function appendGuideText(delta) {
    if (!state.currentBubble) {
      state.currentBubble = addMessage("guide", "");
      state.currentBubble.classList.add("streaming");
    }
    state.currentBubble.textContent += delta;
    transcript.scrollTop = transcript.scrollHeight;
  }

  function closeBubble() {
    if (state.currentBubble) {
      state.currentBubble.classList.remove("streaming");
      if (!state.currentBubble.textContent) state.currentBubble.remove();
      state.currentBubble = null;
    }
  }

  function setStatus(text, busy) {
    statusEl.textContent = text;
    statusEl.classList.toggle("busy", Boolean(busy));
  }

  function setPhase(phase) {
    state.phase = phase;
    var dead = phase === "dead";
    btnPause.disabled = dead || phase === "idle" || phase === "paused";
    btnContinue.disabled = dead || phase === "streaming" || phase === "moving";
    input.disabled = dead;
    if (phase === "idle") setStatus("Listening…", false);
    if (phase === "paused") setStatus("Paused. Type a message or press Continue.", false);
    if (phase === "streaming") setStatus("Thinking…", true);
  }

  function pretty(s) {
    s = String(s).replace(/[_-]+/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function describeMove(move) {
    var a = move.args || {};
    switch (move.name) {
      case "go_to_screen":
        return "Showing you the " + pretty(a.screen || "next") + " screen…";
      case "point_at":
      case "click":
        return "Pointing at " + pretty(a.target || "the screen") + "…";
      case "select_board":
        return "Opening board " + (a.board || "") + "…";
      case "set_markup":
        return "Setting markup to " + (a.percent != null ? a.percent + "%" : "a new value") + "…";
      case "simulate_analysis":
        return "Running the analysis…";
      case "run_export":
        return "Generating the " + pretty(a.document || "document") + "…";
      case "reset_demo":
        return "Resetting the demo…";
      default:
        return "Running " + pretty(move.name) + "…";
    }
  }

  // ---- iframe bridge ---------------------------------------------------------

  function postToApp(msg) {
    if (frame.contentWindow) frame.contentWindow.postMessage(msg, window.location.origin);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
    var msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "demo:ready":
        state.appState = msg.state || null;
        if (!state.ready) {
          state.ready = true;
          if (!state.sessionId) startSession();
        }
        break;
      case "demo:state":
        state.appState = msg.state || null;
        break;
      case "demo:moveResult":
        onMoveResult(msg);
        break;
      case "demo:userAction":
        if (state.phase === "idle" && typeof msg.description === "string" && msg.description) {
          sendText("[visitor action] " + msg.description.slice(0, 300), false);
        }
        break;
    }
  });

  function onMoveResult(msg) {
    if (!state.pendingMove || msg.id !== state.pendingMove.id) return;
    clearTimeout(state.moveTimer);
    state.pendingMove = null;
    var result = { id: msg.id, ok: Boolean(msg.ok) };
    if (typeof msg.result === "string") result.result = msg.result.slice(0, 2000);
    if (typeof msg.error === "string") result.error = msg.error.slice(0, 500);

    if (state.phase === "paused" || state.queuedText !== null) {
      state.heldResult = result;
      if (state.queuedText !== null) {
        var text = state.queuedText;
        state.queuedText = null;
        flushTurn(text);
      }
      return;
    }
    runTurn({ moveResult: result, state: state.appState || undefined });
  }

  function startMove(move) {
    state.pendingMove = move;
    setPhase("moving");
    setStatus(describeMove(move), true);
    postToApp({ type: "demo:move", id: move.id, name: move.name, args: move.args || {} });
    state.moveTimer = setTimeout(function () {
      // Tell the app to abandon the move too, so it is not still "running" when the
      // guide tries the next one; its own "stopped" reply is ignored (id already cleared).
      postToApp({ type: "demo:stop" });
      onMoveResult({ id: move.id, ok: false, error: "The app did not respond in time" });
    }, MOVE_TIMEOUT_MS);
  }

  // ---- session + turns -------------------------------------------------------

  function startSession() {
    setStatus("Starting…", true);
    fetch(api + "/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: config.appId }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || ("Could not start a session (" + res.status + ")"));
          return body;
        });
      })
      .then(function (body) {
        state.sessionId = body.sessionId;
        runTurn({ start: true, state: state.appState || undefined });
      })
      .catch(function (err) {
        addMessage("error", err.message);
        setPhase("dead");
        setStatus("Press Restart to try again.", false);
      });
  }

  function runTurn(body) {
    if (!state.sessionId) return;
    closeBubble();
    var controller = new AbortController();
    state.controller = controller;
    setPhase("streaming");
    fetch(api + "/session/" + encodeURIComponent(state.sessionId) + "/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (err) {
            var e = new Error(err.error || ("Turn failed (" + res.status + ")"));
            e.code = err.code || res.status;
            throw e;
          });
        }
        return readSse(res.body, controller.signal, handleEvent);
      })
      .then(function () {
        if (state.controller === controller) finishStream();
      })
      .catch(function (err) {
        if (controller.signal.aborted) return; // visitor paused
        closeBubble();
        addMessage("error", err.message);
        if (err.code === "expired" || err.code === "cap" || err.code === 410) {
          setPhase("dead");
          setStatus("This session has ended. Press Restart to begin again.", false);
        } else if (state.phase === "streaming") {
          setPhase("idle");
        }
      });
  }

  function finishStream() {
    state.controller = null;
    closeBubble();
    if (state.phase === "streaming") setPhase("idle");
  }

  function handleEvent(event, data) {
    switch (event) {
      case "text":
        appendGuideText(data.delta || "");
        break;
      case "move":
        closeBubble();
        startMove(data);
        break;
      case "error":
        closeBubble();
        addMessage("error", data.message || "Something went wrong.");
        if (data.code === "cap") {
          setPhase("dead");
          setStatus("This session has ended. Press Restart to begin again.", false);
        }
        break;
      case "done":
        // "move": the app is now running it; "end_turn"/"refusal"/"error": wait for the visitor.
        if (data.reason !== "move" && state.phase === "streaming") setPhase("idle");
        break;
    }
  }

  // Minimal SSE reader over fetch (EventSource cannot POST).
  function readSse(body, signal, onEvent) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    function dispatch(block) {
      var event = "message";
      var dataLines = [];
      block.split("\n").forEach(function (line) {
        if (line.indexOf("event:") === 0) event = line.slice(6).trim();
        else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
      });
      if (!dataLines.length) return;
      var data;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch (e) {
        return;
      }
      onEvent(event, data);
    }
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          if (buffer.trim()) dispatch(buffer);
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          var block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (block.trim()) dispatch(block);
        }
        if (signal.aborted) return;
        return pump();
      });
    }
    return pump();
  }

  // ---- visitor actions --------------------------------------------------------

  function pause() {
    if (state.phase === "dead") return;
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
      closeBubble();
    }
    if (state.pendingMove) {
      postToApp({ type: "demo:stop" });
      // The app answers with ok:false,error:"stopped"; onMoveResult holds it.
    }
    setPhase("paused");
  }

  function sendText(text, echo) {
    if (state.phase === "dead" || !state.sessionId) return;
    if (echo) addMessage("visitor", text);
    if (state.phase === "streaming" || state.phase === "moving") pause();
    if (state.pendingMove) {
      // Wait for the stopped move's result so the server sees both together.
      state.queuedText = text;
      setStatus("Stopping the current step…", true);
      return;
    }
    flushTurn(text);
  }

  function flushTurn(text) {
    var body = { userText: text, state: state.appState || undefined };
    if (state.heldResult) {
      body.moveResult = state.heldResult;
      state.heldResult = null;
    }
    runTurn(body);
  }

  function restart() {
    if (state.controller) state.controller.abort();
    clearTimeout(state.moveTimer);
    state.controller = null;
    state.pendingMove = null;
    state.heldResult = null;
    state.queuedText = null;
    state.sessionId = null;
    state.currentBubble = null;
    transcript.innerHTML = "";
    postToApp({ type: "demo:reset" });
    setPhase("idle");
    setStatus("Restarting…", true);
    setTimeout(startSession, 600);
  }

  composer.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendText(text, true);
  });

  btnPause.addEventListener("click", pause);
  btnContinue.addEventListener("click", function () {
    sendText("Please continue.", true);
  });
  btnRestart.addEventListener("click", restart);

  // ---- boot -------------------------------------------------------------------

  setPhase("idle");
  setStatus("Loading the app…", true);
  frame.src = config.iframePath + "?demoOrigin=" + encodeURIComponent(window.location.origin);
  setTimeout(function () {
    // A bundle without a bridge never says ready; start anyway so the guide can talk.
    if (!state.ready && !state.sessionId) startSession();
  }, READY_TIMEOUT_MS);
  input.focus();
})();
