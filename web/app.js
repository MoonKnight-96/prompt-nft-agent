/* Vaulted (prompt NFT marketplace) web app. Plain JS + ethers v6 (loaded from CDN). */
const $ = (id) => document.getElementById(id);
const state = { cfg: null, provider: null, signer: null, account: null, nft: null, market: null, readNft: null, readMarket: null };

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return n; // all user content goes through text nodes, never innerHTML
}
const cfgCurrency = () => (state.cfg && state.cfg.currency) || "ETH";
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const banner = (msg) => { $("banner").textContent = msg; $("banner").classList.toggle("hidden", !msg); };
const errText = (e) => e?.shortMessage || e?.info?.error?.message || e?.reason || e?.message || String(e);

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `Request failed (${r.status})`);
  return body;
}

function metaUrl(uri) {
  return uri.startsWith("ipfs://") ? "https://gateway.pinata.cloud/ipfs/" + uri.slice(7) : uri;
}

// ---------- setup ----------
async function init() {
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.goto)));
  $("connect").addEventListener("click", connect);
  $("createForm").addEventListener("submit", onCreate);
  $("withdraw").addEventListener("click", onWithdraw);
  $("closeDialog").addEventListener("click", () => $("unlockDialog").close());
  $("copyPrompt").addEventListener("click", () => navigator.clipboard.writeText($("unlockText").textContent));

  try {
    state.cfg = await api("/api/config");
  } catch (e) {
    banner("Contracts are not deployed yet. Run the deploy script first.");
    return;
  }
  const cur = cfgCurrency();
  $("netName").textContent = `${state.cfg.chainName || state.cfg.network} (chain ${state.cfg.chainId})`;
  document.querySelectorAll(".cur").forEach((n) => (n.textContent = cur));
  if (state.cfg.operator) {
    // Operator-branded footer (set OPERATOR_NAME / OPERATOR_TERMS_URL / OPERATOR_CONTACT on the server).
    const parts = [el("span", {}, `Operated by ${state.cfg.operator.name}`)];
    if (state.cfg.operator.termsUrl) parts.push(" · ", el("a", { href: state.cfg.operator.termsUrl, target: "_blank", rel: "noopener" }, "Terms & privacy"));
    if (state.cfg.operator.contact) parts.push(" · ", el("span", {}, `Contact: ${state.cfg.operator.contact}`));
    if (state.cfg.explorer) parts.push(" · ", el("a", { href: `${state.cfg.explorer}/address/${state.cfg.marketplace}`, target: "_blank", rel: "noopener" }, "Contracts"));
    $("footerMeta").replaceChildren(...parts);
  }
  if (state.cfg.testnet === false) {
    $("netPill").textContent = `Live on ${state.cfg.chainName}`;
    $("testNote").textContent = `Real ${cur}: transactions are final.`;
  } else {
    $("netPill").textContent = `Live on ${state.cfg.chainName || state.cfg.network} testnet`;
  }
  if (state.cfg.assist) {
    $("assistBox").classList.remove("hidden");
    $("assistBtn").addEventListener("click", onAssist);
  }

  // Reads always go through the public RPC so browsing works with or without a wallet.
  const reader = new ethers.JsonRpcProvider(state.cfg.rpcUrl, state.cfg.chainId, { staticNetwork: true });
  state.readNft = new ethers.Contract(state.cfg.promptNFT, state.cfg.abi.promptNFT, reader);
  state.readMarket = new ethers.Contract(state.cfg.marketplace, state.cfg.abi.marketplace, reader);

  // Show the market first; some wallet extensions take a while (or never) answer.
  loadMarket().catch((e) => banner("Could not load prompts: " + errText(e)));

  state.wallet = await pickWallet();
  if (state.wallet) {
    state.provider = new ethers.BrowserProvider(state.wallet);
    state.wallet.on?.("accountsChanged", () => location.reload());
    state.wallet.on?.("chainChanged", () => location.reload());
    state.wallet.request({ method: "eth_accounts" })
      .then((accts) => (accts.length ? connect().then(loadMarket) : null))
      .catch((e) => console.warn("Wallet not ready:", e));
  } else {
    banner("No wallet found in this browser. You can still browse; tap Connect wallet for options.");
  }
}

// When several wallet extensions are installed (e.g. MetaMask + Phantom), they
// fight over window.ethereum. EIP-6963 lets each announce itself, so we can
// talk to MetaMask directly and fall back to whatever is there.
async function pickWallet() {
  const found = [];
  const onAnnounce = (e) => found.push(e.detail);
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 400));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  const metamask = found.find((p) => p.info?.rdns === "io.metamask");
  return (metamask || found[0])?.provider || window.ethereum || null;
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ["browse", "create", "mine"].forEach((t) => $(t).classList.toggle("hidden", t !== name));
  if (name === "mine") loadMine();
  if (name === "browse") loadMarket();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function connect() {
  if (!state.provider) { showWalletHelp(); return; }
  try {
    await state.wallet.request({ method: "eth_requestAccounts" });
    const chainHex = await state.wallet.request({ method: "eth_chainId" });
    if (Number(chainHex) !== state.cfg.chainId) {
      const hexId = "0x" + state.cfg.chainId.toString(16);
      try {
        try {
          await state.wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
        } catch (err) {
          if (err && err.code === 4902 && state.cfg.explorer) {
            // MetaMask doesn't know this chain yet (common for Polygon): offer to add it.
            await state.wallet.request({ method: "wallet_addEthereumChain", params: [{
              chainId: hexId, chainName: state.cfg.chainName,
              nativeCurrency: { name: cfgCurrency(), symbol: cfgCurrency(), decimals: 18 },
              rpcUrls: [state.cfg.rpcUrl], blockExplorerUrls: [state.cfg.explorer],
            }] });
          } else { throw err; }
        }
      } catch {
        banner(`Switch MetaMask to ${state.cfg.network} (chain ${state.cfg.chainId}), then click Connect wallet again.`);
        return;
      }
      state.provider = new ethers.BrowserProvider(state.wallet); // fresh provider on the new network
    }
    state.signer = await state.provider.getSigner();
    state.account = await state.signer.getAddress();
    state.nft = new ethers.Contract(state.cfg.promptNFT, state.cfg.abi.promptNFT, state.signer);
    state.market = new ethers.Contract(state.cfg.marketplace, state.cfg.abi.marketplace, state.signer);
    $("connect").textContent = short(state.account);
    banner("");
  } catch (e) {
    banner("Wallet connection failed: " + errText(e));
  }
}

const requireWallet = async () => { if (!state.signer) await connect(); return !!state.signer; };

// ---------- data ----------
async function loadToken(id) {
  const [uri, owner, listing] = await Promise.all([
    state.readNft.tokenURI(id), state.readNft.ownerOf(id), state.readMarket.listings(id),
  ]);
  let meta = {};
  try { meta = await (await fetch(metaUrl(uri))).json(); } catch { meta = { name: `Prompt #${id}`, description: "Metadata unavailable" }; }
  const active = listing.seller !== ethers.ZeroAddress && listing.seller.toLowerCase() === owner.toLowerCase();
  return { id, owner, meta, price: active ? listing.price : null };
}

async function allTokens() {
  const total = Number(await state.readNft.totalMinted());
  const ids = Array.from({ length: total }, (_, i) => total - i); // newest first
  return Promise.all(ids.map(loadToken));
}

const COVERS = [
  ["#8b5cf6", "#ec4899"], ["#06b6d4", "#8b5cf6"], ["#f59e0b", "#ef4444"], ["#10b981", "#06b6d4"],
  ["#6366f1", "#22d3ee"], ["#f472b6", "#f59e0b"], ["#14b8a6", "#6366f1"], ["#e11d48", "#7c3aed"],
];
function coverFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = COVERS[h % COVERS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function card(t, actions) {
  const attrs = Object.fromEntries((t.meta.attributes || []).map((a) => [a.trait_type, a.value]));
  const cover = el("div", { class: "cover", style: `--cover:${coverFor((attrs.Category || "") + t.id)}` },
    artSvg((attrs.Category || "") + ":" + t.id),
    el("span", { class: "id" }, `#${t.id}`), el("span", { class: "lock" }, "🔒 Encrypted prompt"));
  actions = [...actions, el("button", { class: "share", title: "Copy link", onclick: () => sharePrompt(t) }, "↗ Share")];
  return el("div", { class: "card", id: `prompt-${t.id}` },
    cover,
    el("div", { class: "body" },
      el("h3", {}, t.meta.name || `Prompt #${t.id}`),
      el("div", { class: "tags" }, el("span", { class: "tag" }, attrs.Model || "Any model"), el("span", { class: "tag" }, attrs.Category || "General")),
      el("div", { class: "meta" }, t.meta.description || ""),
      el("div", { class: "sample" }, t.meta.sample_output || ""),
      el("div", { class: "meta" }, `Owner ${short(t.owner)} · Creator ${short(t.meta.creator)}`),
      el("div", { class: "foot" },
        t.price != null ? el("div", { class: "price" }, `${ethers.formatEther(t.price)} `, el("small", {}, cfgCurrency())) : el("div", { class: "meta" }, "Not for sale"),
        el("div", { class: "actions" }, ...actions)),
    ),
  );
}

const skeletons = (n = 3) => Array.from({ length: n }, () => el("div", { class: "skeleton" }));

async function loadMarket() {
  if (!state.readNft) return;
  const grid = $("market");
  grid.replaceChildren(...skeletons());
  const tokens = await allTokens();
  const forSale = tokens.filter((t) => t.price != null);
  grid.replaceChildren(...(forSale.length ? forSale.map((t) => {
    const mine = state.account && t.owner.toLowerCase() === state.account.toLowerCase();
    return card(t, mine ? [el("span", { class: "meta" }, "You own this")] : [el("button", { class: "primary", onclick: () => onBuy(t) }, "Buy")]);
  }) : [el("p", { class: "empty" }, "No prompts for sale yet. Be the first to mint one.")]));
  renderShowcase(tokens, forSale);
  focusFromHash();
}

async function loadMine() {
  const grid = $("myGrid");
  if (!(await requireWallet())) return;
  grid.replaceChildren(...skeletons());
  $("proceeds").textContent = ethers.formatEther(await state.readMarket.proceeds(state.account));
  const mine = (await allTokens()).filter((t) => t.owner.toLowerCase() === state.account.toLowerCase());
  grid.replaceChildren(...(mine.length ? mine.map((t) => card(t, [
    el("button", { class: "primary", onclick: () => onUnlock(t) }, "Unlock prompt"),
    t.price != null ? el("button", { onclick: () => onCancel(t) }, "Cancel listing") : el("button", { onclick: () => onList(t) }, "List for sale"),
  ])) : [el("p", { class: "empty" }, "You don't own any prompts yet.")]));
}

// ---------- actions ----------
async function onCreate(ev) {
  ev.preventDefault();
  if (!(await requireWallet())) return;
  const f = Object.fromEntries(new FormData(ev.target));
  const log = $("createLog");
  const say = (m) => { log.classList.remove("hidden"); log.textContent += m + "\n"; };
  log.textContent = "";
  const btn = ev.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    say("Encrypting prompt and saving metadata…");
    const prep = await api("/api/prepare", { method: "POST", body: JSON.stringify({
      title: f.title, description: f.description, model: f.model, category: f.category,
      sample_output: f.sample_output, prompt: f.prompt, creator: state.account,
    }) });
    say("Confirm the mint in MetaMask…");
    const royaltyBps = Math.round(Number(f.royalty || 0) * 100);
    const tx = await state.nft.mint(prep.tokenURI, prep.promptHash, royaltyBps);
    const rcpt = await tx.wait();
    const ev2 = rcpt.logs.map((l) => { try { return state.nft.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "PromptMinted");
    const tokenId = ev2.args.tokenId;
    say(`Minted prompt #${tokenId}.`);
    if (f.price && Number(f.price) > 0) {
      await approveAndList(tokenId, f.price, say);
    }
    say("Done.");
    ev.target.reset();
  } catch (e) {
    say("Error: " + errText(e));
  } finally {
    btn.disabled = false;
  }
}

async function onAssist() {
  const idea = $("assistIdea").value.trim();
  const status = $("assistStatus");
  if (idea.length < 10) { status.textContent = "Describe your idea in a sentence or two."; return; }
  const form = $("createForm");
  const btn = $("assistBtn");
  btn.disabled = true;
  status.textContent = "Drafting… this can take up to a minute.";
  try {
    const d = await api("/api/assist", { method: "POST", body: JSON.stringify({
      idea, category: form.category.value, model: form.model.value,
    }) });
    form.title.value = d.title.slice(0, 80);
    form.description.value = d.description.slice(0, 600);
    form.prompt.value = d.prompt.slice(0, 8000);
    form.sample_output.value = d.sample_output.slice(0, 2000);
    status.textContent = "Draft ready. Review and edit it below before minting.";
    form.title.focus();
  } catch (e) {
    status.textContent = errText(e);
  } finally {
    btn.disabled = false;
  }
}

async function approveAndList(tokenId, priceEth, say = () => {}) {
  // Approve only THIS token for the marketplace. We never ask for "approve all"
  // (setApprovalForAll): it's what wallet-draining sites request, so wallets flag it.
  const market = state.cfg.marketplace.toLowerCase();
  const approved = (await state.nft.getApproved(tokenId)).toLowerCase() === market
    || (await state.nft.isApprovedForAll(state.account, state.cfg.marketplace));
  if (!approved) {
    say(`Approve the marketplace to transfer prompt #${tokenId} only, if it sells…`);
    await (await state.nft.approve(state.cfg.marketplace, tokenId)).wait();
  }
  say("Confirm the listing in MetaMask…");
  await (await state.market.list(tokenId, ethers.parseEther(String(priceEth)))).wait();
  say(`Listed for ${priceEth} ${cfgCurrency()}.`);
}

async function onBuy(t) {
  if (!(await requireWallet())) return;
  try {
    await (await state.market.buy(t.id, { value: t.price })).wait();
    alertMsg(`You bought prompt #${t.id}. Open "My prompts" to unlock it.`);
    loadMarket();
  } catch (e) { alertMsg("Purchase failed: " + errText(e)); }
}

async function onList(t) {
  const price = prompt(`Price in ${cfgCurrency()}:`, "0.01");
  if (!price) return;
  try { await approveAndList(t.id, price); loadMine(); } catch (e) { alertMsg("Listing failed: " + errText(e)); }
}

async function onCancel(t) {
  try { await (await state.market.cancel(t.id)).wait(); loadMine(); } catch (e) { alertMsg("Cancel failed: " + errText(e)); }
}

async function onWithdraw() {
  if (!(await requireWallet())) return;
  try { await (await state.market.withdraw()).wait(); loadMine(); } catch (e) { alertMsg("Withdraw failed: " + errText(e)); }
}

async function onUnlock(t) {
  try {
    const { message } = await api(`/api/nonce?token_id=${t.id}&address=${state.account}`);
    const signature = await state.signer.signMessage(message);
    const res = await api("/api/unlock", { method: "POST", body: JSON.stringify({ token_id: t.id, address: state.account, signature }) });
    $("unlockTitle").textContent = t.meta.name || `Prompt #${t.id}`;
    $("unlockText").textContent = res.prompt;
    $("unlockDialog").showModal();
  } catch (e) { alertMsg("Unlock failed: " + errText(e)); }
}

function alertMsg(m) { banner(m); window.scrollTo({ top: 0, behavior: "smooth" }); }

init();


// ---------- v3 visuals ----------
const SVGNS = "http://www.w3.org/2000/svg";
function hashNum(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let x = seed || 1; return () => ((x = Math.imul(x ^ (x >>> 15), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909)) >>> 0) / 4294967296; }
function svg(tag, attrs, ...kids) { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); kids.forEach((k) => n.append(k)); return n; }

// Unique generative artwork per prompt (deterministic from category + id). Numbers only, no user text.
function artSvg(key) {
  const r = rng(hashNum(key)); const hue = Math.floor(r() * 360); const style = Math.floor(r() * 3);
  const c = (dh, l = 60, a = 1) => `hsla(${(hue + dh) % 360},85%,${l}%,${a})`;
  const id = "g" + hashNum(key).toString(36);
  const defs = svg("defs", {},
    svg("linearGradient", { id: id + "a", x1: "0", y1: "0", x2: "1", y2: "1" }, svg("stop", { offset: "0", "stop-color": c(0, 45) }), svg("stop", { offset: "1", "stop-color": c(70, 35) })),
    svg("radialGradient", { id: id + "b" }, svg("stop", { offset: "0", "stop-color": c(180, 70, .9) }), svg("stop", { offset: "1", "stop-color": c(180, 50, 0) })));
  const g = svg("g", { class: "spin" });
  if (style === 0) { for (let i = 0; i < 7; i++) g.append(svg("circle", { cx: 50 + (r() - .5) * 60, cy: 37 + (r() - .5) * 40, r: 8 + r() * 26, fill: c(i * 40, 55 + r() * 20, .35 + r() * .35) })); }
  else if (style === 1) { for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.append(svg("ellipse", { cx: 50 + Math.cos(a) * 18, cy: 37 + Math.sin(a) * 18, rx: 22, ry: 6, transform: `rotate(${(a * 180) / Math.PI} ${50 + Math.cos(a) * 18} ${37 + Math.sin(a) * 18})`, fill: c(i * 25, 65, .28) })); } }
  else { for (let i = 0; i < 6; i++) g.append(svg("rect", { x: 20 + r() * 50, y: 8 + r() * 45, width: 10 + r() * 30, height: 10 + r() * 30, rx: 6, transform: `rotate(${r() * 90} 50 37)`, fill: c(i * 50, 60, .3 + r() * .3) })); }
  return svg("svg", { class: "art", viewBox: "0 0 100 75", preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true" },
    defs, svg("rect", { width: 100, height: 75, fill: `url(#${id}a)` }), svg("circle", { cx: 50 + (r() - .5) * 40, cy: 30, r: 40, fill: `url(#${id}b)` }), g);
}

function renderShowcase(tokens, forSale) {
  const cats = new Set(tokens.map((t) => (t.meta.attributes || []).find((a) => a.trait_type === "Category")?.value).filter(Boolean));
  $("statMinted").textContent = tokens.length;
  $("statListed").textContent = forSale.length;
  const floor = forSale.reduce((m, t) => (m == null || t.price < m ? t.price : m), null);
  $("statFloor").textContent = floor != null ? `${Number(ethers.formatEther(floor)).toString()} ${cfgCurrency()}` : "–";
  $("statCats").textContent = cats.size || "–";
  const words = [...cats, "Finance", "Coding", "Writing", "Marketing", "Research", "Design", "Investing", "Productivity"];
  const pills = [...new Set(words)].map((w) => el("span", {}, `#${w}`));
  $("marquee").replaceChildren(...pills, ...pills.map((p) => p.cloneNode(true)));
  const trending = [...forSale].sort((a, b) => b.id - a.id).slice(0, 8);
  $("trendingHead").classList.toggle("hidden", trending.length < 2);
  $("trending").classList.toggle("hidden", trending.length < 2);
  $("trending").replaceChildren(...trending.map((t) => card(t, [el("button", { class: "primary", onclick: () => focusCard(t.id) }, "View")])));
}

function focusCard(id) {
  const n = document.querySelector(`#market #prompt-${id}`) || document.getElementById(`prompt-${id}`);
  if (!n) return;
  n.scrollIntoView({ behavior: "smooth", block: "center" });
  n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash");
}
function focusFromHash() { const m = location.hash.match(/^#prompt-(\d+)$/); if (m) setTimeout(() => focusCard(m[1]), 300); }

async function sharePrompt(t) {
  const url = `${location.origin}/#prompt-${t.id}`;
  const text = `${t.meta.name || "AI prompt"} on Vaulted`;
  try {
    if (navigator.share) await navigator.share({ title: text, url });
    else { await navigator.clipboard.writeText(url); banner("Link copied. Share it anywhere."); setTimeout(() => banner(""), 2500); }
  } catch { /* user cancelled */ }
}

// Living hero: flowing particle field on a canvas. Replaced by /static/media/hero.mp4 when present.
function startHero() {
  const cv = $("heroCanvas"); if (!cv) return;
  const ctx = cv.getContext("2d"); const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w, h, pts;
  const size = () => { const r = cv.getBoundingClientRect(); w = cv.width = Math.max(300, r.width) * devicePixelRatio; h = cv.height = Math.max(300, r.height) * devicePixelRatio;
    pts = Array.from({ length: Math.min(90, Math.floor(w / 18)) }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .6, vy: (Math.random() - .5) * .6, hue: 250 + Math.random() * 110 })); };
  size(); addEventListener("resize", size);
  let t = 0;
  const frame = () => {
    t += 0.004;
    ctx.fillStyle = "rgba(7,7,13,0.25)"; ctx.fillRect(0, 0, w, h);
    for (const p of pts) {
      const ang = Math.sin(p.x / 240 + t) + Math.cos(p.y / 260 - t);
      p.vx += Math.cos(ang) * 0.03; p.vy += Math.sin(ang) * 0.03; p.vx *= 0.97; p.vy *= 0.97;
      p.x = (p.x + p.vx * devicePixelRatio + w) % w; p.y = (p.y + p.vy * devicePixelRatio + h) % h;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.6 * devicePixelRatio, 0, Math.PI * 2); ctx.fillStyle = `hsla(${p.hue},90%,70%,.9)`; ctx.fill();
    }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y), lim = 120 * devicePixelRatio;
      if (d < lim) { ctx.strokeStyle = `hsla(${a.hue},90%,65%,${(1 - d / lim) * 0.25})`; ctx.lineWidth = devicePixelRatio; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    if (!reduce) requestAnimationFrame(frame);
  };
  frame();
  // Optional AI-generated video: drop web/media/hero.mp4 and it plays automatically.
  fetch("/static/media/hero.mp4", { method: "HEAD" }).then((r) => {
    if (!r.ok) return;
    const v = $("heroVideo"); v.src = "/static/media/hero.mp4"; v.classList.remove("hidden"); v.play().catch(() => {});
  }).catch(() => {});
}
startHero();


// ---------- No-wallet help (Safari, iPhone, browsers without an extension) ----------
function showWalletHelp() {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const here = location.href.split("#")[0];
  const hostPath = here.replace(/^https?:\/\//, "");
  $("openMetaMask").href = `https://metamask.app.link/dapp/${hostPath}`;
  $("openCoinbase").href = `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`;
  $("openTrust").href = `https://link.trustwallet.com/open_url?coin_id=966&url=${encodeURIComponent(here)}`;
  $("walletQr").classList.toggle("hidden", !state.cfg?.walletConnectProjectId);
  $("walletMobile").classList.toggle("hidden", !mobile);
  $("walletDesktop").classList.toggle("hidden", mobile);
  $("walletDialog").showModal();
}
$("closeWallet").addEventListener("click", () => $("walletDialog").close());
$("copySiteLink").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(location.href.split("#")[0]); $("copySiteLink").textContent = "Link copied ✓"; } catch { /* ignore */ }
});

// ---------- WalletConnect (QR code), enabled when the server has WALLETCONNECT_PROJECT_ID ----------
const WC_URL = "https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.17.0/+esm";
async function useWalletConnect() {
  const btn = $("useWalletConnect"); btn.disabled = true; btn.textContent = "Opening QR code…";
  try {
    const { EthereumProvider } = await import(WC_URL);
    const wc = await EthereumProvider.init({
      projectId: state.cfg.walletConnectProjectId,
      chains: [state.cfg.chainId],
      rpcMap: { [state.cfg.chainId]: state.cfg.rpcUrl },
      showQrModal: true,
      metadata: { name: "Vaulted", description: "Own the prompt, not just the picture: AI prompts as NFTs", url: location.origin, icons: [] },
    });
    $("walletDialog").close();
    await wc.connect();
    wc.on("disconnect", () => location.reload());
    wc.on("accountsChanged", () => location.reload());
    state.wallet = wc;
    state.provider = new ethers.BrowserProvider(wc);
    await connect();
  } catch (e) {
    banner("WalletConnect failed: " + errText(e));
  } finally { btn.disabled = false; btn.textContent = "📱 Connect with QR code (WalletConnect)"; }
}
$("useWalletConnect").addEventListener("click", useWalletConnect);
