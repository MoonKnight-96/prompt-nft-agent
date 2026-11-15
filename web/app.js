/* Prompt NFT web app. Plain JS + ethers v6 (loaded from CDN). */
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
  $("netName").textContent = `${state.cfg.network} (chain ${state.cfg.chainId})`;
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
    banner("Install MetaMask to buy or mint prompts. You can still browse.");
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
}

async function connect() {
  if (!state.provider) { banner("Install MetaMask to buy or mint prompts."); return; }
  try {
    await state.wallet.request({ method: "eth_requestAccounts" });
    const chainHex = await state.wallet.request({ method: "eth_chainId" });
    if (Number(chainHex) !== state.cfg.chainId) {
      try {
        await state.wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + state.cfg.chainId.toString(16) }] });
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

function card(t, actions) {
  const attrs = Object.fromEntries((t.meta.attributes || []).map((a) => [a.trait_type, a.value]));
  return el("div", { class: "card" },
    el("h3", {}, t.meta.name || `Prompt #${t.id}`),
    el("div", {}, el("span", { class: "tag" }, attrs.Model || "Any model"), el("span", { class: "tag" }, attrs.Category || "General")),
    el("div", { class: "meta" }, t.meta.description || ""),
    el("div", { class: "sample" }, t.meta.sample_output || ""),
    el("div", { class: "meta" }, `#${t.id} · owner ${short(t.owner)} · creator ${short(t.meta.creator)}`),
    t.price != null ? el("div", { class: "price" }, `${ethers.formatEther(t.price)} ETH`) : el("div", { class: "meta" }, "Not for sale"),
    el("div", { class: "actions" }, ...actions),
  );
}

async function loadMarket() {
  if (!state.readNft) return;
  const grid = $("market");
  grid.replaceChildren(el("p", { class: "empty" }, "Loading…"));
  const tokens = await allTokens();
  const forSale = tokens.filter((t) => t.price != null);
  grid.replaceChildren(...(forSale.length ? forSale.map((t) => {
    const mine = state.account && t.owner.toLowerCase() === state.account.toLowerCase();
    return card(t, mine ? [el("span", { class: "meta" }, "You own this")] : [el("button", { class: "primary", onclick: () => onBuy(t) }, "Buy")]);
  }) : [el("p", { class: "empty" }, "No prompts for sale yet. Be the first to mint one.")]));
}

async function loadMine() {
  const grid = $("myGrid");
  if (!(await requireWallet())) return;
  grid.replaceChildren(el("p", { class: "empty" }, "Loading…"));
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
  const ok = await state.nft.isApprovedForAll(state.account, state.cfg.marketplace);
  if (!ok) {
    say("Approve the marketplace in MetaMask (one time)…");
    await (await state.nft.setApprovalForAll(state.cfg.marketplace, true)).wait();
  }
  say("Confirm the listing in MetaMask…");
  await (await state.market.list(tokenId, ethers.parseEther(String(priceEth)))).wait();
  say(`Listed for ${priceEth} ETH.`);
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
  const price = prompt("Price in ETH:", "0.01");
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
