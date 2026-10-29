(function () {
  if (document.getElementById("oc-spike") || !document.body) return;
  var S = window.OwnCordSpike;
  var log = [];
  var pops = 0;
  window.addEventListener("popstate", function () {
    pops++;
    note("back: popstate fired (" + pops + ")");
    render();
  });
  function note(t) {
    log.push(new Date().toTimeString().slice(0, 8) + " " + t);
    render();
  }
  function status() {
    try {
      return JSON.parse(S.status());
    } catch (e) {
      return { error: String(e) };
    }
  }

  var root = document.createElement("div");
  root.id = "oc-spike";
  root.style.cssText =
    "position:fixed;top:calc(env(safe-area-inset-top) + 56px);right:8px;z-index:2147483647;font:13px sans-serif;color:#fff";
  var pill = document.createElement("button");
  pill.textContent = "Spike";
  pill.style.cssText =
    "background:#c2410c;color:#fff;border:0;border-radius:14px;padding:6px 12px;float:right";
  var panel = document.createElement("div");
  panel.style.cssText =
    "display:none;clear:both;margin-top:6px;background:#111c;border:1px solid #555;border-radius:8px;padding:8px;width:min(86vw,360px);max-height:70vh;overflow:auto";
  pill.onclick = function () {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    render();
  };
  root.appendChild(pill);
  root.appendChild(panel);
  document.body.appendChild(root);

  function btn(label, fn) {
    var b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "display:block;width:100%;margin:4px 0;padding:8px;background:#333;color:#fff;border:1px solid #666;border-radius:6px";
    b.onclick = fn;
    return b;
  }
  var info = document.createElement("pre");
  info.style.cssText = "white-space:pre-wrap;margin:6px 0;font:12px monospace";
  var fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  fileInput.onchange = function () {
    var f = fileInput.files && fileInput.files[0];
    note(
      f
        ? "S-4 picker: got " + f.name + " (" + f.type + ", " + f.size + " bytes)"
        : "S-4 picker: nothing chosen",
    );
  };

  async function mediaTest() {
    try {
      var s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      note(
        "S-2 getUserMedia: OK, tracks " +
          s
            .getTracks()
            .map(function (t) {
              return t.kind + ":" + t.label;
            })
            .join(", "),
      );
      var devs = await navigator.mediaDevices.enumerateDevices();
      devs.forEach(function (d) {
        note("S-2 device " + d.kind + ": " + (d.label || "(no label)"));
      });
      s.getTracks().forEach(function (t) {
        t.stop();
      });
    } catch (e) {
      note("S-2 getUserMedia FAILED: " + (e && e.name) + " " + (e && e.message));
    }
  }

  panel.appendChild(info);
  panel.appendChild(btn("1. Mic + camera test (S-2)", mediaTest));
  panel.appendChild(
    btn("2. Start call service (S-3)", function () {
      note("S-3 start: " + S.startCallService());
    }),
  );
  panel.appendChild(
    btn("2b. Stop call service", function () {
      note("S-3 stop: " + S.stopCallService() + " " + summary3());
    }),
  );
  panel.appendChild(
    btn("3. File picker test (S-4)", function () {
      fileInput.click();
    }),
  );
  panel.appendChild(
    btn("4. Push a back-button step (S-5)", function () {
      history.pushState({ spike: Date.now() }, "");
      note("S-5 pushed a history step; now press the phone's Back");
    }),
  );
  panel.appendChild(
    btn("Copy results", function () {
      var t = report();
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
        function () {
          note("copied");
        },
        function () {
          window.prompt("Copy this:", t);
        },
      );
    }),
  );
  panel.appendChild(fileInput);

  function summary3() {
    var s = status();
    return (
      "running=" +
      s.running +
      " minutes=" +
      Number(s.minutes || 0).toFixed(1) +
      " battery " +
      s.batteryStart +
      "% -> " +
      s.batteryNow +
      "%" +
      (s.error ? " error=" + s.error : "")
    );
  }
  function report() {
    var s = status();
    var vv = window.visualViewport;
    return [
      "device: " + s.device,
      "webview: " + s.webview,
      "ua: " + navigator.userAgent,
      "call service: " + summary3(),
      "viewport: inner " +
        window.innerHeight +
        "px, visual " +
        (vv ? Math.round(vv.height) : "?") +
        "px",
      "popstate count: " + pops,
    ]
      .concat(log)
      .join("\n");
  }
  function render() {
    if (panel.style.display !== "none") info.textContent = report();
  }
  setInterval(render, 5000);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", render);
})();
