(function () {
  const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  let token = localStorage.getItem("hearth_token") || "";
  let user = null;
  let spaces = [];
  let channels = [];
  let messages = [];
  let members = [];
  let dms = [];
  let view = { mode: "server", spaceId: null, channelId: null, dmId: null };
  let authMode = "register";
  let ws = null;

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(path, { ...opts, headers, body: opts.body != null ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
    return data;
  }

  function setAuthMode(m) {
    authMode = m;
    $("tab-login").classList.toggle("active", m === "login");
    $("tab-register").classList.toggle("active", m === "register");
    $("name-field").style.display = m === "register" ? "block" : "none";
    $("auth-submit").textContent = m === "login" ? "Sign in" : "Create account";
    $("auth-error").textContent = "";
  }
  $("tab-login").onclick = () => setAuthMode("login");
  $("tab-register").onclick = () => setAuthMode("register");

  $("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    $("auth-error").textContent = "";
    $("auth-submit").disabled = true;
    try {
      const email = $("auth-email").value.trim().toLowerCase();
      const password = $("auth-password").value;
      const displayName = $("auth-name").value.trim();
      const path = authMode === "register" ? "/api/register" : "/api/login";
      const body = authMode === "register" ? { email, password, displayName } : { email, password };
      const data = await api(path, { method: "POST", body });
      token = data.token;
      user = data.user;
      localStorage.setItem("hearth_token", token);
      await enterApp();
    } catch (err) {
      $("auth-error").textContent = err.message || String(err);
    } finally {
      $("auth-submit").disabled = false;
    }
  };

  function connectLive() {
    if (ws) try { ws.close(); } catch {}
    ws = new EventSource("/api/events?token=" + encodeURIComponent(token));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "message" && msg.channelId === view.channelId) {
          const i = messages.findIndex((m) => m.id === msg.message.id);
          if (msg.message.deleted) messages = messages.filter((m) => m.id !== msg.message.id);
          else if (i >= 0) messages[i] = msg.message;
          else messages.push(msg.message);
          renderMessages();
        }
        if (msg.type === "dm_message" && msg.dmId === view.dmId) {
          const i = messages.findIndex((m) => m.id === msg.message.id);
          if (i >= 0) messages[i] = msg.message;
          else messages.push(msg.message);
          renderMessages();
        }
        if (msg.type === "presence" || msg.type === "members") refreshMembers();
        if (msg.type === "channels" && msg.spaceId === view.spaceId) refreshChannels();
        if (msg.type === "spaces") refreshSpaces();
      } catch {}
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
      setTimeout(() => { if (token) connectLive(); }, 2000);
    };
  }

  async function enterApp() {
    $("auth-screen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("me-name").textContent = user.displayName;
    $("me-letter").textContent = user.displayName.charAt(0).toUpperCase();
    connectLive();
    await refreshSpaces();
  }

  async function refreshSpaces() {
    const data = await api("/api/spaces");
    spaces = data.spaces;
    if (!view.spaceId && spaces[0]) {
      view = { mode: "server", spaceId: spaces[0].id, channelId: null, dmId: null };
    }
    renderRail();
    if (view.mode === "server" && view.spaceId) {
      await refreshChannels();
      await refreshMembers();
    } else if (view.mode === "dm") {
      await refreshDms();
    }
  }

  async function refreshChannels() {
    if (!view.spaceId) return;
    const data = await api("/api/spaces/" + view.spaceId + "/channels");
    channels = data.channels;
    if (!view.channelId || !channels.some((c) => c.id === view.channelId)) {
      view.channelId = channels[0]?.id || null;
    }
    renderSidebar();
    renderHeader();
    await refreshMessages();
  }

  async function refreshMembers() {
    if (!view.spaceId) return;
    try {
      const data = await api("/api/spaces/" + view.spaceId + "/members");
      members = data.members;
      renderMembers();
    } catch {}
  }

  async function refreshDms() {
    const data = await api("/api/dms");
    dms = data.dms;
    if (!view.dmId && dms[0]) view.dmId = dms[0].id;
    renderSidebar();
    renderHeader();
    await refreshMessages();
  }

  async function refreshMessages() {
    try {
      if (view.mode === "server" && view.channelId) {
        const data = await api("/api/channels/" + view.channelId + "/messages");
        messages = data.messages;
      } else if (view.mode === "dm" && view.dmId) {
        const data = await api("/api/dms/" + view.dmId + "/messages");
        messages = data.messages;
      } else {
        messages = [];
      }
      renderMessages();
    } catch {
      messages = [];
      renderMessages();
    }
  }

  function renderRail() {
    const rail = $("server-rail");
    rail.innerHTML = "";
    const home = document.createElement("button");
    home.type = "button";
    home.className = "server-btn dm-home" + (view.mode === "dm" ? " active" : "");
    home.title = "Direct Messages";
    home.textContent = "💬";
    home.onclick = async () => {
      view = { mode: "dm", spaceId: null, channelId: null, dmId: null };
      await refreshDms();
      renderRail();
      $("members-panel").innerHTML = "";
    };
    rail.appendChild(home);
    const sep = document.createElement("div");
    sep.className = "rail-sep";
    rail.appendChild(sep);
    spaces.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "server-btn" + (view.mode === "server" && view.spaceId === s.id ? " active" : "");
      b.title = s.name;
      b.textContent = s.icon || s.name.charAt(0).toUpperCase();
      b.onclick = async () => {
        view = { mode: "server", spaceId: s.id, channelId: null, dmId: null };
        renderRail();
        await refreshChannels();
        await refreshMembers();
      };
      rail.appendChild(b);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "server-btn add";
    add.title = "Add a Server";
    add.textContent = "+";
    add.onclick = openServerModal;
    rail.appendChild(add);
  }

  function renderSidebar() {
    const body = $("sidebar-body");
    body.innerHTML = "";
    if (view.mode === "dm") {
      $("sidebar-title").textContent = "Direct Messages";
      $("btn-sidebar-action").onclick = openNewDm;
      if (!dms.length) {
        body.innerHTML = '<p style="color:var(--muted);font-size:.85rem;padding:8px">No DMs yet. Click + and enter someone’s email.</p>';
        return;
      }
      dms.forEach((d) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ch-item" + (view.dmId === d.id ? " active" : "");
        btn.textContent = "👤 " + d.other.displayName;
        btn.onclick = async () => { view.dmId = d.id; renderSidebar(); renderHeader(); await refreshMessages(); };
        body.appendChild(btn);
      });
    } else {
      const space = spaces.find((s) => s.id === view.spaceId);
      $("sidebar-title").textContent = space?.name || "Server";
      $("btn-sidebar-action").onclick = openAddChannel;
      const cats = {};
      channels.forEach((c) => {
        const cat = c.category || "Text Channels";
        (cats[cat] = cats[cat] || []).push(c);
      });
      Object.keys(cats).forEach((cat) => {
        const lab = document.createElement("div");
        lab.className = "cat-label";
        lab.textContent = "▼ " + cat;
        body.appendChild(lab);
        cats[cat].forEach((c) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ch-item" + (view.channelId === c.id ? " active" : "");
          btn.innerHTML = "<span>#</span> " + esc(c.name);
          btn.onclick = async () => {
            view.channelId = c.id;
            renderSidebar();
            renderHeader();
            await refreshMessages();
          };
          body.appendChild(btn);
        });
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "ch-item";
      add.textContent = "+ Add channel";
      add.onclick = openAddChannel;
      body.appendChild(add);
    }
  }

  function renderHeader() {
    if (view.mode === "dm") {
      $("head-icon").textContent = "@";
      const d = dms.find((x) => x.id === view.dmId);
      $("head-title").textContent = d?.other.displayName || "Select a conversation";
      $("head-topic").textContent = "";
      $("btn-invite").classList.add("hidden");
    } else {
      $("head-icon").textContent = "#";
      const ch = channels.find((c) => c.id === view.channelId);
      $("head-title").textContent = ch?.name || "channel";
      $("head-topic").textContent = ch?.topic || "";
      $("btn-invite").classList.remove("hidden");
    }
  }

  function formatDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  }

  function renderMessages() {
    const box = $("messages");
    box.innerHTML = "";
    if (!messages.length) {
      box.innerHTML = '<div class="empty-state"><h3>No messages yet</h3><p>Be the first to say something.</p></div>';
      return;
    }
    let lastDay = "";
    messages.forEach((m) => {
      if (m.deleted) return;
      const day = formatDay(m.ts);
      if (day !== lastDay) {
        lastDay = day;
        const sep = document.createElement("div");
        sep.className = "day-sep";
        sep.textContent = day;
        box.appendChild(sep);
      }
      const el = document.createElement("div");
      el.className = "msg";
      const t = new Date(m.ts);
      const timeStr = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      let rxHtml = "";
      if (m.reactions && Object.keys(m.reactions).length) {
        rxHtml = '<div class="reactions">' + Object.entries(m.reactions).map(([emoji, ids]) => {
          const on = ids.includes(user.id) ? " on" : "";
          return `<button type="button" class="rx${on}" data-emoji="${esc(emoji)}">${emoji} ${ids.length}</button>`;
        }).join("") + "</div>";
      }
      el.innerHTML = `
        <div class="av">${esc((m.authorName || "?").charAt(0).toUpperCase())}</div>
        <div class="meta"><span class="name${m.userId === user.id ? " me" : ""}">${esc(m.authorName)}</span>
          <span class="time">${timeStr}</span>${m.edited ? ' <span class="time">(edited)</span>' : ""}</div>
        <div class="body">${esc(m.body)}</div>${rxHtml}
        <div class="msg-actions">
          <button type="button" data-act="react">😀</button>
          ${m.userId === user.id ? '<button type="button" data-act="edit">✏️</button><button type="button" data-act="del">🗑️</button>' : ""}
        </div>`;
      el.querySelectorAll(".rx").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          await api("/api/messages/" + m.id + "/react", { method: "POST", body: { emoji: btn.dataset.emoji } });
        };
      });
      el.querySelectorAll(".msg-actions button").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === "react") showPicker(e, m.id);
          if (act === "edit") {
            const next = prompt("Edit message", m.body);
            if (next != null && next.trim()) {
              await api("/api/messages/" + m.id, { method: "PATCH", body: { body: next.trim() } });
            }
          }
          if (act === "del" && confirm("Delete this message?")) {
            await api("/api/messages/" + m.id, { method: "PATCH", body: { deleted: true } });
          }
        };
      });
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
  }

  function renderMembers() {
    const panel = $("members-panel");
    if (view.mode !== "server") { panel.innerHTML = ""; return; }
    const online = members.filter((m) => m.online);
    const offline = members.filter((m) => !m.online);
    let html = "";
    if (online.length) {
      html += `<h4>Online — ${online.length}</h4>`;
      online.forEach((m) => {
        html += `<div class="member"><div class="av">${esc(m.displayName.charAt(0).toUpperCase())}<span class="dot on"></span></div>
          <div><div class="nm">${esc(m.displayName)}</div><div class="role">${esc(m.role)}</div></div></div>`;
      });
    }
    if (offline.length) {
      html += `<h4 style="margin-top:16px">Offline — ${offline.length}</h4>`;
      offline.forEach((m) => {
        html += `<div class="member"><div class="av" style="opacity:.5">${esc(m.displayName.charAt(0).toUpperCase())}<span class="dot off"></span></div>
          <div><div class="nm" style="opacity:.6">${esc(m.displayName)}</div><div class="role">${esc(m.role)}</div></div></div>`;
      });
    }
    panel.innerHTML = html;
  }

  async function sendMessage() {
    const body = $("msg-input").value.trim();
    if (!body) return;
    $("msg-input").value = "";
    try {
      if (view.mode === "server" && view.channelId) {
        await api("/api/channels/" + view.channelId + "/messages", { method: "POST", body: { body } });
      } else if (view.mode === "dm" && view.dmId) {
        await api("/api/dms/" + view.dmId + "/messages", { method: "POST", body: { body } });
      }
    } catch (err) {
      alert(err.message);
    }
  }
  $("btn-send").onclick = sendMessage;
  $("msg-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  function showPicker(e, msgId) {
    const root = $("picker-root");
    root.innerHTML = "";
    const p = document.createElement("div");
    p.className = "picker";
    p.style.left = Math.min(e.clientX, window.innerWidth - 280) + "px";
    p.style.top = Math.max(8, e.clientY - 48) + "px";
    EMOJIS.forEach((em) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = em;
      b.onclick = async () => {
        await api("/api/messages/" + msgId + "/react", { method: "POST", body: { emoji: em } });
        root.innerHTML = "";
      };
      p.appendChild(b);
    });
    root.appendChild(p);
    setTimeout(() => {
      const close = (ev) => { if (!p.contains(ev.target)) { root.innerHTML = ""; document.removeEventListener("click", close); } };
      document.addEventListener("click", close);
    }, 0);
  }

  function modal(html) {
    const root = $("modal-root");
    root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
    root.querySelector(".modal-bg").onclick = (e) => { if (e.target.classList.contains("modal-bg")) root.innerHTML = ""; };
  }
  function closeModal() { $("modal-root").innerHTML = ""; }

  function openServerModal() {
    modal(`
      <h2>Add a Server</h2>
      <div class="field"><label style="font-size:.75rem;font-weight:700;color:var(--muted)">CREATE NEW</label>
        <input id="m-name" placeholder="Server name" maxlength="32" /></div>
      <div class="field"><label style="font-size:.75rem;font-weight:700;color:var(--muted)">OR JOIN WITH INVITE</label>
        <input id="m-invite" placeholder="Invite code" maxlength="12" style="text-transform:uppercase" /></div>
      <div class="actions">
        <button type="button" class="cancel" id="m-cancel">Cancel</button>
        <button type="button" class="ok" id="m-join">Join</button>
        <button type="button" class="ok" id="m-create">Create</button>
      </div>`);
    $("m-cancel").onclick = closeModal;
    $("m-create").onclick = async () => {
      try {
        const data = await api("/api/spaces", { method: "POST", body: { name: $("m-name").value } });
        view = { mode: "server", spaceId: data.space.id, channelId: data.channelId, dmId: null };
        closeModal();
        await refreshSpaces();
      } catch (err) { alert(err.message); }
    };
    $("m-join").onclick = async () => {
      try {
        const data = await api("/api/spaces/join", { method: "POST", body: { invite: $("m-invite").value } });
        view = { mode: "server", spaceId: data.space.id, channelId: data.channelId, dmId: null };
        closeModal();
        await refreshSpaces();
      } catch (err) { alert(err.message); }
    };
  }

  function openAddChannel() {
    modal(`
      <h2>Create Channel</h2>
      <div class="field"><label style="font-size:.75rem;font-weight:700;color:var(--muted)">NAME</label>
        <input id="m-cname" placeholder="new-channel" maxlength="24" /></div>
      <div class="field"><label style="font-size:.75rem;font-weight:700;color:var(--muted)">TOPIC</label>
        <input id="m-ctopic" placeholder="Optional" maxlength="120" /></div>
      <div class="actions">
        <button type="button" class="cancel" id="m-cancel">Cancel</button>
        <button type="button" class="ok" id="m-ok">Create</button>
      </div>`);
    $("m-cancel").onclick = closeModal;
    $("m-ok").onclick = async () => {
      try {
        const data = await api("/api/channels", {
          method: "POST",
          body: { spaceId: view.spaceId, name: $("m-cname").value, topic: $("m-ctopic").value },
        });
        view.channelId = data.channel.id;
        closeModal();
        await refreshChannels();
      } catch (err) { alert(err.message); }
    };
  }

  function openNewDm() {
    modal(`
      <h2>New Direct Message</h2>
      <div class="field"><label style="font-size:.75rem;font-weight:700;color:var(--muted)">THEIR EMAIL</label>
        <input id="m-email" type="email" placeholder="friend@example.com" /></div>
      <div class="actions">
        <button type="button" class="cancel" id="m-cancel">Cancel</button>
        <button type="button" class="ok" id="m-ok">Open DM</button>
      </div>`);
    $("m-cancel").onclick = closeModal;
    $("m-ok").onclick = async () => {
      try {
        const data = await api("/api/dms", { method: "POST", body: { email: $("m-email").value } });
        view = { mode: "dm", spaceId: null, channelId: null, dmId: data.dm.id };
        closeModal();
        await refreshDms();
        renderRail();
      } catch (err) { alert(err.message); }
    };
  }

  $("btn-invite").onclick = () => {
    const space = spaces.find((s) => s.id === view.spaceId);
    if (!space) return;
    modal(`
      <h2>Invite people</h2>
      <p style="color:var(--muted);font-size:.9rem">Share this code so others can join <strong>${esc(space.name)}</strong>.</p>
      <div class="invite-code">${esc(space.invite)}</div>
      <div class="actions">
        <button type="button" class="cancel" id="m-cancel">Close</button>
        <button type="button" class="ok" id="m-copy">Copy</button>
      </div>`);
    $("m-cancel").onclick = closeModal;
    $("m-copy").onclick = () => { navigator.clipboard?.writeText(space.invite); closeModal(); };
  };

  $("btn-logout").onclick = async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch {}
    token = "";
    user = null;
    localStorage.removeItem("hearth_token");
    if (ws) ws.close();
    $("app").classList.add("hidden");
    $("auth-screen").classList.remove("hidden");
    $("auth-form").reset();
    setAuthMode("register");
  };

  (async () => {
    if (token) {
      try {
        const data = await api("/api/me");
        user = data.user;
        await enterApp();
        return;
      } catch {
        localStorage.removeItem("hearth_token");
        token = "";
      }
    }
    setAuthMode("register");
  })();
})();
