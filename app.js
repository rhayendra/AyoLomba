let appData = {
  events: [],
  participantCount: 0,
  serverTime: ''
};

let activeEventId = 'bulan-bahasa';
let activeCompId = 'bb-puisi';
let activeWsTab = 'juknis';
let juknisViewedMap = {};
let panitiaSession = null;
let participantContext = null; // { authenticated, participant, event, competition, bracketStatus, allRegistrations }
let countdownTimer = null;

const currentPage = document.body.getAttribute('data-page') || 'home';

document.addEventListener('DOMContentLoaded', async () => {
  parseUrlParams();
  await Promise.all([
    checkParticipantSession(),
    checkPanitiaSession(),
    fetchPublicData()
  ]);

  if (currentPage === 'home') {
    initHomePage();
    startCountdownLoop();
  } else if (currentPage === 'daftar') {
    initDaftarPage();
  } else if (currentPage === 'peserta') {
    initPesertaPage();
  }
});

function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const evParam = params.get('event');
  const compParam = params.get('comp');
  const readParam = params.get('read');
  if (evParam) activeEventId = evParam;
  if (compParam) {
    activeCompId = compParam;
    if (readParam === '1') {
      juknisViewedMap[compParam] = true;
    }
  }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg, isError = false) {
  const wrap = document.getElementById('toastContainer');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all 0.2s ease';
    setTimeout(() => el.remove(), 220);
  }, 3800);
}

function scrollToEl(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}

document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

function buildQrSvg(seedText) {
  const str = (seedText || 'AYO-LOMBA-PASS').toUpperCase();
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const size = 7;
  const cell = 6;
  const total = size * cell;
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isCorner =
        (x < 2 && y < 2) ||
        (x >= size - 2 && y < 2) ||
        (x < 2 && y >= size - 2);
      const bit = ((hash >>> ((y * size + x) % 31)) ^ (x * 7 + y * 13)) & 1;
      if (isCorner || bit === 1) {
        rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell - 0.5}" height="${cell - 0.5}" rx="1" fill="#1B4332"/>`;
      }
    }
  }
  return `<svg width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

// Participant Session & Persistent Navbar Indicator
async function checkParticipantSession() {
  try {
    const res = await fetch('/api/participant/me');
    const data = await res.json();
    participantContext = data.authenticated ? data : null;
  } catch {
    participantContext = null;
  }
  renderGlobalParticipantNavbar();
}

function renderGlobalParticipantNavbar() {
  const zone = document.getElementById('navParticipantZone');
  const topBanner = document.getElementById('topAuthBanner');
  const homeAlert = document.getElementById('homeLoggedStudentAlert');
  const heroBtn = document.getElementById('heroBtnPeserta');

  if (participantContext && participantContext.participant) {
    const p = participantContext.participant;
    const initials = (p.nama || 'P')
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    if (zone) {
      zone.innerHTML = `
        <a href="/peserta" class="user-identity-pill" style="text-decoration: none;" title="Klik untuk melihat Kartu Lomba & Password Anda">
          <span class="u-avatar">${esc(initials)}</span>
          <span>${esc(p.nama)} &bull; Kelas ${esc(p.kelas)}</span>
        </a>
        <a href="/peserta" class="btn btn-hunter btn-sm">Kartu Saya (${esc(p.id)})</a>
        <button type="button" class="btn btn-danger btn-sm" onclick="logoutParticipant()">Keluar</button>
      `;
    }

    if (topBanner) {
      topBanner.innerHTML = `LOGIN PESERTA AKTIF: <strong>${esc(p.nama)}</strong> (KELAS ${esc(p.kelas)}) &mdash; ${esc(p.eventName)} (${esc(p.competitionName)}) &bull; ID: ${esc(p.id)}`;
    }

    if (homeAlert) {
      homeAlert.style.display = 'block';
      homeAlert.innerHTML = `
        Anda sedang login sebagai <strong>${esc(p.nama)}</strong> (Kelas <strong>${esc(p.kelas)}</strong>) pada cabang <strong>${esc(p.competitionName)}</strong> (${esc(p.eventName)}).
        <a href="/peserta" style="color: var(--hunter-deep); font-weight: 800; text-decoration: underline; margin-left: 6px;">Lihat Kartu &amp; Password Saya &rarr;</a>
      `;
    }

    if (heroBtn) {
      heroBtn.textContent = `Buka Kartu Saya (${p.nama} - ${p.kelas})`;
    }
  } else {
    if (zone) {
      zone.innerHTML = `<a href="/peserta" class="btn btn-hunter">Login Peserta</a>`;
    }
    if (homeAlert) {
      homeAlert.style.display = 'none';
    }
    if (heroBtn) {
      heroBtn.textContent = 'Buka Kartu / Login Peserta';
    }
  }
}

async function logoutParticipant() {
  await fetch('/api/participant/logout', { method: 'POST' });
  participantContext = null;
  renderGlobalParticipantNavbar();
  showToast('Anda telah keluar dari akun peserta.');
  if (currentPage === 'peserta') {
    initPesertaPage();
  }
}

// Panitia Session
async function checkPanitiaSession() {
  try {
    const res = await fetch('/api/panitia/me');
    const data = await res.json();
    panitiaSession = data.authenticated ? data.panitia : null;
  } catch {
    panitiaSession = null;
  }
  updatePanitiaUIState();
}

function updatePanitiaUIState() {
  const navBtn = document.getElementById('btnNavPanitia');
  const bracketBar = document.getElementById('panitiaBracketToolbar');
  if (!navBtn) return;
  if (panitiaSession) {
    navBtn.textContent = `Panitia: ${panitiaSession.id}`;
    navBtn.className = 'btn btn-parchment';
    if (bracketBar) bracketBar.style.display = 'flex';
  } else {
    navBtn.textContent = 'Login Panitia';
    navBtn.className = 'btn btn-outline';
    if (bracketBar) bracketBar.style.display = 'none';
  }
}

async function fetchPublicData() {
  try {
    const res = await fetch('/api/public-data');
    appData = await res.json();

    if (!appData.events.some((e) => e.id === activeEventId) && appData.events.length > 0) {
      activeEventId = appData.events[0].id;
    }
    const activeEv = appData.events.find((e) => e.id === activeEventId);
    if (activeEv && !activeEv.competitions.some((c) => c.id === activeCompId)) {
      activeCompId = activeEv.competitions[0]?.id || '';
    }

    const clockEl = document.getElementById('serverClockBanner');
    if (clockEl) {
      clockEl.textContent = appData.serverTime ? `WAKTU SERVER: ${appData.serverTime}` : '';
    }
  } catch {
    showToast('Gagal memuat data perlombaan.', true);
  }
}

function findCompetitionById(compId) {
  for (const ev of appData.events) {
    const comp = (ev.competitions || []).find((c) => c.id === compId);
    if (comp) return { ev, comp };
  }
  return null;
}

// ==========================================
// 1. HOME PAGE LOGIC (/)
// ==========================================
function initHomePage() {
  const badge = document.getElementById('ledgerParticipantBadge');
  if (badge) badge.textContent = `${appData.participantCount} Peserta Terdaftar`;

  renderHeroLedger();
  renderEventRibbon();
  renderCatalogIndex();
  renderHomeWorkspaceDetail();
  populateMainBracketSelector();
  renderMainBracket();
}

function computeCountdownText(ev) {
  if (ev.locked) return 'DITUTUP PANITIA';
  if (!ev.registrationDeadline) return 'TERBUKA';
  const target = new Date(ev.registrationDeadline);
  const now = new Date();
  const diff = target - now;
  if (Number.isNaN(target.getTime())) return ev.registrationDeadline;
  if (diff <= 0) return 'TERKUNCI JADWAL';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hrs = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const mins = Math.floor((diff / (1000 * 60)) % 60);
  if (days > 0) return `${days}h ${String(hrs).padStart(2, '0')}j ${String(mins).padStart(2, '0')}m`;
  const secs = Math.floor((diff / 1000) % 60);
  return `${String(hrs).padStart(2, '0')}j ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}d`;
}

function startCountdownLoop() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    appData.events.forEach((ev) => {
      const el = document.getElementById(`cd-${ev.id}`);
      if (el) el.textContent = computeCountdownText(ev);
    });
  }, 1000);
}

function renderHeroLedger() {
  const list = document.getElementById('heroLedgerList');
  if (!list) return;
  list.innerHTML = appData.events
    .map((ev) => {
      const badgeCls = ev.effectiveLocked ? 'badge-locked' : 'badge-open';
      const statusLbl = ev.locked ? 'Locked' : ev.scheduleLocked ? 'Schedule Lock' : 'Available';
      return `
        <div class="ledger-item" onclick="selectEvent('${esc(ev.id)}'); scrollToEl('workspaceSection');">
          <div>
            <div style="font-weight: 700; font-size: 13.5px; color: var(--hunter-deep);">${esc(ev.name)}</div>
            <div style="font-size: 11.5px; color: var(--muted);">Tutup Daftar: ${esc((ev.registrationDeadline || '-').replace('T', ' '))}</div>
          </div>
          <div style="text-align: right;">
            <span class="badge ${badgeCls}">${statusLbl}</span>
            <div class="ledger-countdown" id="cd-${esc(ev.id)}">${esc(computeCountdownText(ev))}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderEventRibbon() {
  const ribbon = document.getElementById('eventRibbon');
  if (!ribbon) return;
  ribbon.innerHTML = appData.events
    .map((ev) => {
      const isActive = ev.id === activeEventId;
      const pillCls = ev.effectiveLocked ? 'badge-locked' : 'badge-open';
      const pillTxt = ev.locked ? 'Locked' : ev.scheduleLocked ? 'Jadwal Tutup' : 'Available';
      return `
        <button type="button" class="event-ribbon-card ${isActive ? 'active' : ''}" onclick="selectEvent('${esc(ev.id)}')">
          <div>
            <div class="ribbon-title">${esc(ev.name)}</div>
            <div class="ribbon-sub">${esc(ev.subtitle)} &bull; ${(ev.competitions || []).length} Cabang</div>
          </div>
          <span class="badge ${pillCls}">${pillTxt}</span>
        </button>
      `;
    })
    .join('');
}

function selectEvent(eventId) {
  activeEventId = eventId;
  const ev = appData.events.find((e) => e.id === eventId);
  activeCompId = ev?.competitions?.[0]?.id || '';
  activeWsTab = 'juknis';
  if (activeCompId) juknisViewedMap[activeCompId] = true;
  renderEventRibbon();
  renderCatalogIndex();
  if (currentPage === 'home') renderHomeWorkspaceDetail();
  if (currentPage === 'daftar') renderDaftarWorkspaceDetail();
}

function selectCompetition(compId) {
  activeCompId = compId;
  activeWsTab = 'juknis';
  juknisViewedMap[compId] = true;
  renderCatalogIndex();
  if (currentPage === 'home') renderHomeWorkspaceDetail();
  if (currentPage === 'daftar') renderDaftarWorkspaceDetail();
}

function renderCatalogIndex() {
  const ev = appData.events.find((e) => e.id === activeEventId);
  if (!ev) return;

  const titleEl = document.getElementById('catalogEventTitle');
  const metaEl = document.getElementById('catalogEventMeta');
  if (titleEl) titleEl.textContent = `Indeks Lomba: ${ev.name}`;
  if (metaEl) metaEl.textContent = `${ev.participantCount || 0} siswa terdaftar pada event ini`;

  const list = document.getElementById('catalogList');
  if (!list) return;
  const comps = ev.competitions || [];
  if (comps.length === 0) {
    list.innerHTML = `<div style="padding: 18px; font-size: 13px; color: var(--muted);">Belum ada cabang lomba pada event ini.</div>`;
    return;
  }

  list.innerHTML = comps
    .map((c, idx) => {
      const isAct = c.id === activeCompId;
      const num = String(idx + 1).padStart(2, '0');
      const pillCls = c.effectiveLocked ? 'badge-locked' : 'badge-open';
      const pillTxt = c.effectiveLocked ? 'Terkunci' : 'Buka';
      const juknisOk = juknisViewedMap[c.id] ? 'Juknis dibaca' : 'Baca juknis dulu';
      return `
        <button type="button" class="catalog-item ${isAct ? 'active' : ''}" onclick="selectCompetition('${esc(c.id)}')">
          <div class="catalog-num">${num}</div>
          <div class="catalog-info">
            <div class="catalog-name">${esc(c.name)}</div>
            <div class="catalog-meta">
              <span>${esc(c.category)} &bull; ${juknisOk}</span>
              <span class="badge ${pillCls}">${pillTxt}</span>
            </div>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderHomeWorkspaceDetail() {
  const found = findCompetitionById(activeCompId);
  if (!found) return;
  const { ev, comp } = found;

  document.getElementById('wsEventBadge').textContent = ev.name;
  document.getElementById('wsCatBadge').textContent = comp.category;
  const stBadge = document.getElementById('wsStatusBadge');
  stBadge.textContent = comp.effectiveLocked ? 'TERKUNCI' : 'AVAILABLE';
  stBadge.className = `badge ${comp.effectiveLocked ? 'badge-locked' : 'badge-open'}`;

  document.getElementById('wsCompTitle').textContent = comp.name;
  document.getElementById('wsCountLabel').textContent = `${comp.participantCount || 0} peserta terdaftar`;
  document.getElementById('wsJuknisContent').textContent = comp.juknis;
  document.getElementById('wsBracketTitle').textContent = comp.name;

  const btnGo = document.getElementById('btnGoToDedicatedDaftar');
  if (btnGo) {
    btnGo.href = `/daftar?event=${encodeURIComponent(ev.id)}&comp=${encodeURIComponent(comp.id)}&read=1`;
    btnGo.textContent = comp.effectiveLocked
      ? `Lihat Status Pendaftaran ${comp.name}`
      : `Ikuti Lomba "${comp.name}" di Halaman Pendaftaran &rarr;`;
    btnGo.innerHTML = comp.effectiveLocked
      ? `Lihat Status Pendaftaran ${esc(comp.name)}`
      : `Ikuti Lomba "${esc(comp.name)}" di Halaman Pendaftaran &rarr;`;
  }

  document.getElementById('wsTabJuknis').className = `detail-tab ${activeWsTab === 'juknis' ? 'active' : ''}`;
  document.getElementById('wsTabBracket').className = `detail-tab ${activeWsTab === 'bracket' ? 'active' : ''}`;
  document.getElementById('wsPanelJuknis').style.display = activeWsTab === 'juknis' ? 'block' : 'none';
  document.getElementById('wsPanelBracket').style.display = activeWsTab === 'bracket' ? 'block' : 'none';

  if (activeWsTab === 'bracket') {
    renderBracketTreeInto(document.getElementById('wsBracketContainer'), ev, comp, true);
  }
}

function switchHomeCompTab(tabName) {
  activeWsTab = tabName;
  renderHomeWorkspaceDetail();
}

// ==========================================
// 2. DEDICATED REGISTRATION PAGE (/daftar)
// ==========================================
function initDaftarPage() {
  if (activeCompId) {
    juknisViewedMap[activeCompId] = true;
  }

  // If participant is already logged in, prefill Nama & Kelas and show banner
  if (participantContext && participantContext.participant) {
    const p = participantContext.participant;
    const banner = document.getElementById('daftarAlreadyLoggedBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = `
        <strong>Akun Aktif Terdeteksi:</strong> Anda sedang login sebagai <strong>${esc(p.nama)}</strong> (Kelas <strong>${esc(p.kelas)}</strong>).
        Nama &amp; Kelas Anda telah diisi otomatis untuk memudahkan jika ingin mendaftar di Event Utama lainnya, atau
        <a href="/peserta" style="color: var(--hunter-deep); font-weight: 800; text-decoration: underline;">Kembali ke Kartu Lomba Saya &rarr;</a>
      `;
    }
    const namaInput = document.getElementById('regNama');
    const kelasInput = document.getElementById('regKelas');
    if (namaInput && !namaInput.value) namaInput.value = p.nama;
    if (kelasInput && !kelasInput.value) kelasInput.value = p.kelas;
  }

  // If URL had ?read=1 from homepage Juknis, we can still start at 'juknis' or allow immediate switch
  const params = new URLSearchParams(window.location.search);
  if (params.get('read') === '1' && activeCompId) {
    juknisViewedMap[activeCompId] = true;
    activeWsTab = 'register';
  } else {
    activeWsTab = 'juknis';
  }

  renderEventRibbon();
  renderCatalogIndex();
  renderDaftarWorkspaceDetail();
}

function renderDaftarWorkspaceDetail() {
  const found = findCompetitionById(activeCompId);
  if (!found) return;
  const { ev, comp } = found;

  if (activeWsTab === 'juknis') {
    juknisViewedMap[comp.id] = true;
  }

  document.getElementById('wsEventBadge').textContent = ev.name;
  document.getElementById('wsCatBadge').textContent = comp.category;
  const stBadge = document.getElementById('wsStatusBadge');
  stBadge.textContent = comp.effectiveLocked ? 'TERKUNCI' : 'AVAILABLE';
  stBadge.className = `badge ${comp.effectiveLocked ? 'badge-locked' : 'badge-open'}`;

  document.getElementById('wsCompTitle').textContent = comp.name;
  document.getElementById('wsCountLabel').textContent = `${comp.participantCount || 0} peserta terdaftar`;
  document.getElementById('wsJuknisContent').textContent = comp.juknis;

  const isJuknisRead = Boolean(juknisViewedMap[comp.id]);
  document.getElementById('wsTabJuknis').className = `detail-tab ${activeWsTab === 'juknis' ? 'active' : ''}`;
  document.getElementById('wsTabRegister').className = `detail-tab ${activeWsTab === 'register' ? 'active' : ''} ${isJuknisRead ? '' : 'locked'}`;
  document.getElementById('wsTabLockIcon').innerHTML = isJuknisRead ? '&#10003;' : '&#128274;';

  document.getElementById('wsPanelJuknis').style.display = activeWsTab === 'juknis' ? 'block' : 'none';
  document.getElementById('wsPanelRegister').style.display = activeWsTab === 'register' ? 'block' : 'none';

  const lockBanner = document.getElementById('wsLockBanner');
  const submitBtn = document.getElementById('btnSubmitReg');
  if (comp.effectiveLocked) {
    lockBanner.style.display = 'block';
    lockBanner.textContent = ev.locked
      ? `Event ${ev.name} sedang ditutup oleh panitia.`
      : ev.scheduleLocked
      ? `Pendaftaran terkunci otomatis karena melewati batas jadwal (${ev.registrationDeadline.replace('T', ' ')}).`
      : `Cabang ${comp.name} sedang dikunci oleh panitia.`;
    submitBtn.disabled = true;
  } else {
    lockBanner.style.display = 'none';
    submitBtn.disabled = false;
  }

  // Atur Tampilan Khusus Lomba Kelompok / Beregu
  const isGroup = Boolean(comp.isGroup) || comp.category?.toLowerCase().includes('tim') || comp.category?.toLowerCase().includes('kelompok');
  const minMembers = comp.minMembers || (isGroup ? 2 : 1);
  const groupContainer = document.getElementById('groupFieldsContainer');
  const groupMinBadge = document.getElementById('groupMinBadge');

  if (groupContainer) {
    if (isGroup) {
      groupContainer.style.display = 'block';
      if (groupMinBadge) groupMinBadge.textContent = `Wajib Minimal ${minMembers} Pendaftar`;
      const regNamaKelompok = document.getElementById('regNamaKelompok');
      if (regNamaKelompok) regNamaKelompok.required = true;
      // Inisialisasi input anggota tim default jika masih kosong
      initGroupMemberInputs(minMembers);
    } else {
      groupContainer.style.display = 'none';
      const regNamaKelompok = document.getElementById('regNamaKelompok');
      if (regNamaKelompok) {
        regNamaKelompok.required = false;
        regNamaKelompok.value = '';
      }
      const list = document.getElementById('groupMembersList');
      if (list) list.innerHTML = '';
    }
  }

  updateLivePass();
}

function initGroupMemberInputs(minMembers) {
  const list = document.getElementById('groupMembersList');
  if (!list) return;
  // Jika sudah terisi dari sebelumnya dan jumlah sudah sesuai, pertahankan isinya
  const existingInputs = list.querySelectorAll('.group-member-input');
  const neededAdditional = Math.max(0, minMembers - 1); // 1 ketua + (minMembers - 1) anggota
  if (existingInputs.length === 0 && neededAdditional > 0) {
    list.innerHTML = '';
    for (let i = 0; i < neededAdditional; i++) {
      addGroupMemberInput(i + 1, false);
    }
  }
  updateGroupCountIndicator();
}

function addGroupMemberInput(indexNum, focusNew = true) {
  const list = document.getElementById('groupMembersList');
  if (!list) return;
  const currentCount = list.querySelectorAll('.group-member-row').length + 1;
  const num = indexNum || currentCount;
  
  const row = document.createElement('div');
  row.className = 'group-member-row';
  row.style.cssText = 'display: flex; gap: 8px; align-items: center;';
  row.innerHTML = `
    <span style="font-size: 11px; font-weight: 700; color: var(--hunter-medium); width: 68px; flex-shrink: 0;">Anggota ${num}:</span>
    <input type="text" class="form-control group-member-input" placeholder="Nama lengkap anggota tim..." oninput="updateGroupCountIndicator()" style="font-size: 13px; padding: 7px 10px;" required>
    <button type="button" class="btn btn-outline" style="padding: 5px 9px; color: var(--danger); font-size: 11px; border-color: #e5b3b3;" onclick="removeGroupMemberRow(this)">&times;</button>
  `;
  list.appendChild(row);
  if (focusNew) {
    const input = row.querySelector('input');
    if (input) input.focus();
  }
  updateGroupCountIndicator();
}

function removeGroupMemberRow(btn) {
  const row = btn.closest('.group-member-row');
  if (row) {
    row.remove();
    // Re-label anggota numbers
    const list = document.getElementById('groupMembersList');
    if (list) {
      const rows = list.querySelectorAll('.group-member-row');
      rows.forEach((r, idx) => {
        const lbl = r.querySelector('span');
        if (lbl) lbl.textContent = `Anggota ${idx + 1}:`;
      });
    }
  }
  updateGroupCountIndicator();
}

function updateGroupCountIndicator() {
  const found = findCompetitionById(activeCompId);
  const comp = found ? found.comp : null;
  const isGroup = comp ? (Boolean(comp.isGroup) || comp.category?.toLowerCase().includes('tim') || comp.category?.toLowerCase().includes('kelompok')) : false;
  const minMembers = comp?.minMembers || (isGroup ? 2 : 1);

  const list = document.getElementById('groupMembersList');
  const countIndicator = document.getElementById('groupCountIndicator');
  if (!list || !countIndicator) return;

  const filledMembers = Array.from(list.querySelectorAll('.group-member-input'))
    .map(i => i.value.trim())
    .filter(Boolean);

  const total = 1 + filledMembers.length; // 1 Ketua + anggota
  const meetMin = total >= minMembers;
  countIndicator.innerHTML = `Total Terdata: <strong>${total}</strong> dari min. <strong>${minMembers}</strong> orang ${meetMin ? '&#10003; (Lengkap)' : '&#9888; (Kurang ' + (minMembers - total) + ' orang)'}`;
  countIndicator.style.color = meetMin ? 'var(--hunter-deep)' : 'var(--danger)';
  updateLivePass();
}

function switchDaftarTab(tabName) {
  const found = findCompetitionById(activeCompId);
  if (!found) return;
  if (tabName === 'register' && !juknisViewedMap[found.comp.id]) {
    showToast('Silakan buka dan baca Kisi-Kisi & Juknis terlebih dahulu!', true);
    return;
  }
  activeWsTab = tabName;
  if (tabName === 'juknis') {
    juknisViewedMap[found.comp.id] = true;
    renderCatalogIndex();
  }
  renderDaftarWorkspaceDetail();
}

function confirmJuknisAndOpenForm() {
  const found = findCompetitionById(activeCompId);
  if (!found) return;
  juknisViewedMap[found.comp.id] = true;
  activeWsTab = 'register';
  renderCatalogIndex();
  renderDaftarWorkspaceDetail();
}

function updateLivePass() {
  const found = findCompetitionById(activeCompId);
  if (!found) return;
  const { ev, comp } = found;

  const namaEl = document.getElementById('regNama');
  const kelasEl = document.getElementById('regKelas');
  if (!namaEl || !kelasEl) return;

  const namaVal = namaEl.value.trim();
  const kelasVal = kelasEl.value.trim();

  document.getElementById('livePassEvent').textContent = ev.name;
  document.getElementById('livePassNama').textContent = namaVal || 'Nama Peserta';
  document.getElementById('livePassKelas').textContent = kelasVal ? `Kelas ${kelasVal}` : 'Kelas • Pratinjau Langsung';
  document.getElementById('livePassComp').textContent = `Cabang: ${comp.name}`;
  
  const teamEl = document.getElementById('livePassTeam');
  const namaKelompokEl = document.getElementById('regNamaKelompok');
  if (teamEl) {
    const isGroup = Boolean(comp.isGroup) || comp.category?.toLowerCase().includes('tim') || comp.category?.toLowerCase().includes('kelompok');
    if (isGroup && namaKelompokEl && namaKelompokEl.value.trim()) {
      teamEl.style.display = 'block';
      teamEl.textContent = `Tim: ${namaKelompokEl.value.trim()}`;
    } else {
      teamEl.style.display = 'none';
    }
  }

  document.getElementById('livePassQr').innerHTML = buildQrSvg(namaVal || comp.id);
}

async function submitRegistrationPage(e) {
  e.preventDefault();
  const found = findCompetitionById(activeCompId);
  if (!found) return;
  const { ev, comp } = found;

  const isGroup = Boolean(comp.isGroup) || comp.category?.toLowerCase().includes('tim') || comp.category?.toLowerCase().includes('kelompok');
  const minMembers = comp.minMembers || (isGroup ? 2 : 1);

  const namaKelompokVal = (document.getElementById('regNamaKelompok')?.value || '').trim();
  let anggotaList = [];
  if (isGroup) {
    if (!namaKelompokVal) {
      showToast('Wajib mengisi Nama Kelompok / Tim!', true);
      document.getElementById('regNamaKelompok')?.focus();
      return;
    }
    const memberInputs = document.querySelectorAll('.group-member-input');
    anggotaList = Array.from(memberInputs)
      .map(i => i.value.trim())
      .filter(Boolean);
    const totalPendaftar = 1 + anggotaList.length; // 1 Ketua + anggota
    if (totalPendaftar < minMembers) {
      showToast(`Lomba '${comp.name}' butuh minimal ${minMembers} pendaftar dalam 1 kelompok. Saat ini baru ada ${totalPendaftar} orang (Ketua + ${anggotaList.length} anggota). Silakan klik '+ Tambah Anggota Tim'`, true);
      return;
    }
  }

  const payload = {
    eventId: ev.id,
    competitionId: comp.id,
    nama: document.getElementById('regNama').value.trim(),
    kelas: document.getElementById('regKelas').value.trim(),
    kontak: document.getElementById('regKontak').value.trim(),
    catatan: document.getElementById('regCatatan').value.trim(),
    namaKelompok: namaKelompokVal,
    anggotaList: anggotaList,
    juknisViewed: Boolean(juknisViewedMap[comp.id])
  };

  const btn = document.getElementById('btnSubmitReg');
  btn.disabled = true;
  btn.textContent = 'Mendaftarkan & Masuk ke Akun Anda...';

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Pendaftaran gagal.', true);
      btn.disabled = false;
      btn.textContent = 'Kirim Pendaftaran & Otomatis Masuk Akun →';
      return;
    }

    // Automatically logged in by backend -> redirect immediately to dedicated /peserta page!
    window.location.href = data.redirectUrl || '/peserta?welcome=1';
  } catch {
    showToast('Terjadi gangguan koneksi ke server.', true);
    btn.disabled = false;
    btn.textContent = 'Kirim Pendaftaran & Otomatis Masuk Akun →';
  }
}

// ==========================================
// 3. DEDICATED PARTICIPANT PAGE (/peserta)
// ==========================================
async function initPesertaPage() {
  const dashView = document.getElementById('pesertaDashboardView');
  const loginView = document.getElementById('pesertaLoginView');
  const welcomeBanner = document.getElementById('welcomeAutoLoginBanner');

  const params = new URLSearchParams(window.location.search);
  const autoId = params.get('auto_id');
  const autoPw = params.get('auto_pw');

  // Jika baru saja mendaftar dan cookie sesi Vercel belum terbaca, otomatis login dengan kredensial pendaftaran!
  if ((!participantContext || !participantContext.participant) && autoId && autoPw) {
    try {
      const res = await fetch('/api/participant/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: autoId, password: autoPw })
      });
      const data = await res.json();
      if (data.success) {
        participantContext = data;
        participantContext.authenticated = true;
        renderGlobalParticipantNavbar();
      }
    } catch (e) {
      console.error('Auto login fallback error:', e);
    }
  }

  if (welcomeBanner) {
    welcomeBanner.style.display = params.get('welcome') === '1' ? 'block' : 'none';
  }

  if (participantContext && participantContext.participant) {
    dashView.style.display = 'block';
    loginView.style.display = 'none';
    renderPesertaDashboardPage();
  } else {
    dashView.style.display = 'none';
    loginView.style.display = 'block';
  }
}

function renderPesertaDashboardPage() {
  const p = participantContext.participant;
  const ev = participantContext.event;
  const comp = participantContext.competition;
  const allRegs = participantContext.allRegistrations || [];

  document.getElementById('dashHeaderTitle').textContent = `Halo, ${p.nama} (${p.kelas})`;
  document.getElementById('profNama').textContent = p.nama;
  document.getElementById('profKelas').textContent = p.kelas;
  document.getElementById('profEvent').textContent = p.eventName;
  document.getElementById('profComp').textContent = p.competitionName;
  document.getElementById('profCreds').textContent = `${p.id} / ${p.password}`;

  const profGroupCard = document.getElementById('profGroupCard');
  const profGroupVal = document.getElementById('profGroupVal');
  if (profGroupCard && profGroupVal) {
    if (p.isGroup && p.namaKelompok) {
      profGroupCard.style.display = 'block';
      const anggotaStr = (p.anggotaList && p.anggotaList.length > 0) ? ` (${p.totalPendaftar || (1 + p.anggotaList.length)} orang: ${p.nama} [Ketua], ${p.anggotaList.join(', ')})` : '';
      profGroupVal.textContent = `${p.namaKelompok}${anggotaStr}`;
    } else {
      profGroupCard.style.display = 'none';
    }
  }

  // Permanent Digital Card
  document.getElementById('dashPassEvent').textContent = p.eventName;
  document.getElementById('dashPassNama').textContent = p.nama;
  document.getElementById('dashPassKelas').textContent = `Kelas ${p.kelas} • Kontak: ${p.kontak}`;
  document.getElementById('dashPassComp').textContent = `Cabang: ${p.competitionName}`;
  const dashTeamEl = document.getElementById('dashPassTeam');
  if (dashTeamEl) {
    if (p.isGroup && p.namaKelompok) {
      dashTeamEl.style.display = 'block';
      dashTeamEl.textContent = `Tim: ${p.namaKelompok} (${p.totalPendaftar || (1 + (p.anggotaList ? p.anggotaList.length : 0))} Anggota)`;
    } else {
      dashTeamEl.style.display = 'none';
    }
  }
  document.getElementById('dashPassId').textContent = p.id;
  document.getElementById('dashPassPw').textContent = p.password;
  document.getElementById('dashPassQr').innerHTML = buildQrSvg(p.id);
  document.getElementById('dashPassTime').textContent = `TERDAFTAR RESMI • ${p.registeredAt}`;

  // Multi-event switcher if student registered in more than 1 event
  const switcher = document.getElementById('multiCardSwitcher');
  if (allRegs.length > 1) {
    switcher.style.display = 'flex';
    switcher.innerHTML =
      `<span style="font-size: 12px; color: var(--muted); font-weight: 700;">Kartu Event Anda:</span>` +
      allRegs
        .map(
          (r) => `
          <button type="button" class="btn btn-sm ${r.id === p.id ? 'btn-hunter' : 'btn-parchment'}" onclick="switchParticipantCard('${esc(r.id)}')">
            ${esc(r.eventName)} (${esc(r.id)})
          </button>
        `
        )
        .join('');
  } else {
    switcher.style.display = 'none';
  }

  document.getElementById('dashCompTitle').textContent = `${p.eventName} — ${p.competitionName}`;
  document.getElementById('dashBracketStatus').textContent = participantContext.bracketStatus || '-';
  document.getElementById('dashJuknisBox').textContent = comp?.juknis || 'Juknis tersedia di katalog.';

  const treeBox = document.getElementById('dashBracketTree');
  if (ev && comp) {
    renderBracketTreeInto(treeBox, ev, comp, true);
  } else {
    treeBox.innerHTML = '<div class="alert-box alert-brass">Data bagan belum tersedia.</div>';
  }
}

async function switchParticipantCard(targetId) {
  const res = await fetch('/api/participant/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: targetId })
  });
  const data = await res.json();
  if (data.success) {
    participantContext = data;
    participantContext.authenticated = true;
    renderGlobalParticipantNavbar();
    renderPesertaDashboardPage();
    showToast(`Menampilkan kartu ${data.participant.eventName}.`);
  }
}

function copyDashCard() {
  if (!participantContext?.participant) return;
  const p = participantContext.participant;
  const txt = `KARTU PESERTA AYO LOMBA\nNama: ${p.nama} (Kelas ${p.kelas})\nLomba: ${p.eventName} - ${p.competitionName}\nID User: ${p.id}\nPassword: ${p.password}`;
  navigator.clipboard?.writeText(txt).then(() => {
    showToast('ID User & Password berhasil disalin!');
  }).catch(() => {
    showToast(`ID: ${p.id} | Password: ${p.password}`);
  });
}

async function submitPesertaPageLogin(e) {
  e.preventDefault();
  const id = document.getElementById('pLoginId').value.trim();
  const password = document.getElementById('pLoginPw').value.trim();

  try {
    const res = await fetch('/api/participant/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Login peserta gagal.', true);
      return;
    }

    participantContext = data;
    participantContext.authenticated = true;
    renderGlobalParticipantNavbar();
    initPesertaPage();
    showToast(`Selamat datang kembali, ${data.participant.nama} (${data.participant.kelas})!`);
  } catch {
    showToast('Gagal menghubungi server.', true);
  }
}

// ==========================================
// 4. BRACKET & PANITIA CONTROLS
// ==========================================
function populateMainBracketSelector() {
  const sel = document.getElementById('mainBracketSelect');
  if (!sel) return;
  const prev = sel.value;
  const opts = [];
  appData.events.forEach((ev) => {
    (ev.competitions || []).forEach((c) => {
      opts.push({ id: c.id, label: `${ev.name} — ${c.name}` });
    });
  });

  sel.innerHTML = opts.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
  if (prev && opts.some((o) => o.id === prev)) {
    sel.value = prev;
  } else {
    const withBracket = opts.find((o) => findCompetitionById(o.id)?.comp?.bracket?.rounds?.length > 0);
    if (withBracket) sel.value = withBracket.id;
  }
}

function selectMainBracketComp(compId) {
  const sel = document.getElementById('mainBracketSelect');
  if (sel) {
    sel.value = compId;
    renderMainBracket();
  }
}

function syncMainBracketToCurrent() {
  selectMainBracketComp(activeCompId);
  scrollToEl('bracketSection');
}

function renderMainBracket() {
  const sel = document.getElementById('mainBracketSelect');
  const container = document.getElementById('mainBracketContainer');
  if (!sel || !container) return;

  const compId = sel.value;
  const found = findCompetitionById(compId);
  if (!found) {
    container.innerHTML = '<div class="alert-box alert-brass">Belum ada cabang lomba.</div>';
    return;
  }
  const { ev, comp } = found;
  document.getElementById('mainBracketSub').textContent = panitiaSession
    ? `Mode Panitia Aktif (${ev.name} — ${comp.name}): Klik 'Shuffle' untuk acak random, atau klik 'Maju ->' pada slot peserta.`
    : `Bagan Resmi ${ev.name} — ${comp.name} (${comp.participantCount || 0} pendaftar terdaftar).`;
  renderBracketTreeInto(container, ev, comp, false);
}

function renderBracketTreeInto(container, ev, comp, compact) {
  if (!container) return;
  const bracket = comp.bracket || { rounds: [], champion: '' };
  const rounds = bracket.rounds || [];

  if (rounds.length === 0) {
    container.innerHTML = `
      <div class="alert-box alert-brass" style="margin-bottom: 0;">
        Bagan turnamen untuk <strong>${esc(comp.name)}</strong> belum diacak oleh panitia.
        ${panitiaSession ? ' Klik <strong>Shuffle (Acak Bagan)</strong> untuk membuat undian acak otomatis.' : ''}
      </div>
    `;
    return;
  }

  const roundsHtml = rounds
    .map((round, rIdx) => {
      const isLast = rIdx === rounds.length - 1;
      const matchesHtml = (round.matches || [])
        .map((m, mIdx) => {
          const canAdv1 = panitiaSession && !compact && m.p1 && m.p1 !== 'BYE' && !m.p1.startsWith('Menunggu');
          const canAdv2 = panitiaSession && !compact && m.p2 && m.p2 !== 'BYE' && !m.p2.startsWith('Menunggu');

          const cls1 = m.winner === m.p1 ? 'winner' : m.p1 === 'BYE' || m.p1.startsWith('Menunggu') ? 'muted' : '';
          const cls2 = m.winner === m.p2 ? 'winner' : m.p2 === 'BYE' || m.p2.startsWith('Menunggu') ? 'muted' : '';

          return `
            <div class="b-match">
              <div class="b-slot ${cls1}">
                <span>${esc(m.p1)}</span>
                ${
                  m.winner === m.p1
                    ? '<span class="badge badge-open">LOLOS</span>'
                    : canAdv1
                    ? `<button class="btn btn-hunter btn-sm" style="padding:2px 8px; font-size:11px;" onclick="advanceWinner('${esc(comp.id)}', ${rIdx}, ${mIdx}, 'p1')">Maju &rarr;</button>`
                    : ''
                }
              </div>
              <div class="b-slot ${cls2}">
                <span>${esc(m.p2)}</span>
                ${
                  m.winner === m.p2
                    ? '<span class="badge badge-open">LOLOS</span>'
                    : canAdv2
                    ? `<button class="btn btn-hunter btn-sm" style="padding:2px 8px; font-size:11px;" onclick="advanceWinner('${esc(comp.id)}', ${rIdx}, ${mIdx}, 'p2')">Maju &rarr;</button>`
                    : ''
                }
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="b-round ${isLast ? 'b-last' : ''}">
          <div class="b-round-label">${esc(round.name)}</div>
          <div class="b-matches">${matchesHtml}</div>
        </div>
      `;
    })
    .join('');

  const champHtml = `
    <div class="b-champ-col">
      <div class="b-champ-card">
        <small>Juara Utama</small>
        <h4>${esc(bracket.champion || 'Menunggu Final')}</h4>
      </div>
    </div>
  `;

  container.innerHTML = `<div class="bracket-tree-wrap">${roundsHtml}${champHtml}</div>`;
}

async function panitiaBracketAction(action) {
  if (!panitiaSession) {
    openModal('panitiaLoginModal');
    return;
  }
  const compId = document.getElementById('mainBracketSelect').value;
  try {
    const res = await fetch('/api/panitia/bracket/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compId, action })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Gagal memperbarui bagan.', true);
      return;
    }
    showToast(data.message);
    await fetchPublicData();
    selectMainBracketComp(compId);
  } catch {
    showToast('Gagal menghubungi server.', true);
  }
}

async function advanceWinner(compId, roundIndex, matchIndex, slotKey) {
  if (!panitiaSession) return;
  const found = findCompetitionById(compId);
  const winner = found?.comp?.bracket?.rounds?.[roundIndex]?.matches?.[matchIndex]?.[slotKey];
  if (!winner) return;

  try {
    const res = await fetch('/api/panitia/bracket/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compId, action: 'advance', roundIndex, matchIndex, winner })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Gagal memajukan pemenang.', true);
      return;
    }
    showToast(data.message);
    await fetchPublicData();
    selectMainBracketComp(compId);
  } catch {
    showToast('Gagal terhubung ke server.', true);
  }
}

function openPanitiaPortal() {
  if (panitiaSession) {
    loadAndOpenPanitiaDashboard();
  } else {
    openModal('panitiaLoginModal');
  }
}

async function submitPanitiaLogin(e) {
  e.preventDefault();
  const id = document.getElementById('panitiaIdInput').value.trim();
  const password = document.getElementById('panitiaPwInput').value.trim();

  try {
    const res = await fetch('/api/panitia/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Login panitia ditolak.', true);
      return;
    }

    panitiaSession = data.panitia;
    document.getElementById('panitiaPwInput').value = '';
    updatePanitiaUIState();
    closeModal('panitiaLoginModal');
    showToast(`Selamat datang, ${panitiaSession.name}!`);
    renderMainBracket();
    await loadAndOpenPanitiaDashboard();
  } catch {
    showToast('Gagal terhubung ke server.', true);
  }
}

async function logoutPanitia() {
  await fetch('/api/panitia/logout', { method: 'POST' });
  panitiaSession = null;
  updatePanitiaUIState();
  closeModal('panitiaDashModal');
  renderMainBracket();
  showToast('Berhasil keluar dari portal panitia.');
}

async function loadAndOpenPanitiaDashboard() {
  if (!panitiaSession) return;
  document.getElementById('panitiaIdentityLabel').textContent =
    `${panitiaSession.name} (${panitiaSession.role}) • ID: ${panitiaSession.id}`;

  await fetchPublicData();
  if (currentPage === 'home') initHomePage();
  renderPanitiaEventsControl();
  renderPanitiaCompsControl();
  await fetchPanitiaParticipants();
  await fetchPanitiaAdminsList();
  openModal('panitiaDashModal');
}

function renderPanitiaEventsControl() {
  const wrap = document.getElementById('panitiaEventsControl');
  if (!wrap) return;
  wrap.innerHTML = appData.events
    .map((ev) => {
      const isManualLocked = Boolean(ev.locked);
      return `
        <div class="panitia-box">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <strong style="color: var(--hunter-deep);">${esc(ev.name)}</strong>
            <span class="badge ${ev.effectiveLocked ? 'badge-locked' : 'badge-open'}">
              ${isManualLocked ? 'Ditutup Manual' : ev.scheduleLocked ? 'Terkunci Jadwal' : 'Available'}
            </span>
          </div>
          <button class="btn btn-sm ${isManualLocked ? 'btn-hunter' : 'btn-danger'}" style="width: 100%; margin-bottom: 10px;" onclick="toggleEventLock('${esc(ev.id)}')">
            ${isManualLocked ? 'Buka Event (Available)' : 'Kunci / Tutup Event'}
          </button>
          <div class="form-group" style="margin-bottom: 7px;">
            <label style="font-size: 11px;">Batas Daftar (Schedule Lock)</label>
            <input type="datetime-local" id="dl-${esc(ev.id)}" class="form-control" style="padding: 6px 8px; font-size: 12px;" value="${esc(ev.registrationDeadline || '')}">
          </div>
          <div class="form-group" style="margin-bottom: 8px;">
            <label style="font-size: 11px;">Tanggal Pelaksanaan</label>
            <input type="datetime-local" id="ed-${esc(ev.id)}" class="form-control" style="padding: 6px 8px; font-size: 12px;" value="${esc(ev.eventDate || '')}">
          </div>
          <button class="btn btn-parchment btn-sm" style="width: 100%;" onclick="saveEventSchedule('${esc(ev.id)}')">
            Simpan Jadwal Event
          </button>
        </div>
      `;
    })
    .join('');
}

function renderPanitiaCompsControl() {
  const wrap = document.getElementById('panitiaCompsControl');
  if (!wrap) return;
  const cards = [];
  appData.events.forEach((ev) => {
    (ev.competitions || []).forEach((c) => {
      cards.push(`
        <div class="panitia-box" style="display: flex; flex-direction: column; justify-content: space-between; gap: 8px;">
          <div>
            <div style="font-size: 10.5px; font-weight: 700; color: var(--brass); text-transform: uppercase;">${esc(ev.name)}</div>
            <div style="font-weight: 700; color: var(--hunter-deep); font-size: 14px;">${esc(c.name)}</div>
            <div style="font-size: 12px; color: var(--muted);">${c.participantCount || 0} peserta terdaftar</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-parchment btn-sm" style="flex: 1;" onclick="openEditJuknis('${esc(c.id)}')">Ubah Juknis</button>
            <button class="btn btn-sm ${c.locked ? 'btn-hunter' : 'btn-danger'}" style="flex: 1;" onclick="toggleCompLock('${esc(c.id)}')">
              ${c.locked ? 'Buka' : 'Kunci'}
            </button>
          </div>
        </div>
      `);
    });
  });
  wrap.innerHTML = cards.join('');
}

async function fetchPanitiaParticipants() {
  const res = await fetch('/api/panitia/participants');
  if (res.status === 401) return;
  const data = await res.json();
  const list = data.participants || [];
  document.getElementById('panitiaTotalRows').textContent = `Total: ${list.length} peserta`;
  const tbody = document.getElementById('panitiaParticipantsBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 18px; color: var(--muted);">Belum ada peserta mendaftar.</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map(
      (p) => `
      <tr>
        <td class="mono" style="font-weight: 700;">${esc(p.id)}</td>
        <td class="mono">${esc(p.password)}</td>
        <td><strong>${esc(p.nama)}</strong></td>
        <td>${esc(p.kelas)}</td>
        <td>${esc(p.eventName)}</td>
        <td>${esc(p.competitionName)}</td>
        <td>${esc(p.kontak)}</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteParticipant('${esc(p.id)}')">Hapus</button>
        </td>
      </tr>
    `
    )
    .join('');
}

async function toggleEventLock(eventId) {
  const res = await fetch('/api/panitia/toggle-event-lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId })
  });
  const data = await res.json();
  if (data.success) {
    showToast(data.locked ? 'Event ditutup.' : 'Event dibuka (Available).');
    await loadAndOpenPanitiaDashboard();
  }
}

async function saveEventSchedule(eventId) {
  const registrationDeadline = document.getElementById(`dl-${eventId}`).value;
  const eventDate = document.getElementById(`ed-${eventId}`).value;
  const res = await fetch('/api/panitia/update-event-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, registrationDeadline, eventDate })
  });
  const data = await res.json();
  if (data.success) {
    showToast(data.message);
    await loadAndOpenPanitiaDashboard();
  }
}

async function toggleCompLock(compId) {
  const res = await fetch('/api/panitia/toggle-comp-lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compId })
  });
  const data = await res.json();
  if (data.success) {
    showToast(data.locked ? 'Lomba dikunci.' : 'Lomba dibuka.');
    await loadAndOpenPanitiaDashboard();
  }
}

function toggleAddCompGroup(isGroup) {
  const wrapper = document.getElementById('addCompGroupMinWrapper');
  const catInput = document.getElementById('addCompCategory');
  if (wrapper) wrapper.style.display = isGroup ? 'block' : 'none';
  if (catInput) {
    if (isGroup && catInput.value === 'Individu') {
      catInput.value = 'Beregu / Tim';
    } else if (!isGroup && catInput.value === 'Beregu / Tim') {
      catInput.value = 'Individu';
    }
  }
}

async function submitNewCompetition(e) {
  e.preventDefault();
  const isGroup = Boolean(document.getElementById('addCompIsGroup')?.checked);
  const minMembers = isGroup ? parseInt(document.getElementById('addCompMinMembers')?.value || '2', 10) : 1;

  const payload = {
    eventId: document.getElementById('addCompEventId').value,
    name: document.getElementById('addCompName').value.trim(),
    category: document.getElementById('addCompCategory').value.trim(),
    isGroup: isGroup,
    minMembers: minMembers,
    juknis: document.getElementById('addCompJuknis').value.trim()
  };
  const res = await fetch('/api/panitia/add-competition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.success) {
    showToast(data.message);
    document.getElementById('addCompName').value = '';
    document.getElementById('addCompJuknis').value = '';
    if (document.getElementById('addCompIsGroup')) document.getElementById('addCompIsGroup').checked = false;
    toggleAddCompGroup(false);
    closeModal('addCompModal');
    await loadAndOpenPanitiaDashboard();
  } else {
    showToast(data.message || 'Gagal menambah cabang lomba.', true);
  }
}

function openEditJuknis(compId) {
  const found = findCompetitionById(compId);
  if (!found) return;
  document.getElementById('editJuknisTitle').textContent = `Edit Juknis: ${found.comp.name}`;
  document.getElementById('editJuknisCompId').value = compId;
  document.getElementById('editJuknisTextarea').value = found.comp.juknis || '';
  openModal('editJuknisModal');
}

async function submitEditJuknis(e) {
  e.preventDefault();
  const compId = document.getElementById('editJuknisCompId').value;
  const juknis = document.getElementById('editJuknisTextarea').value.trim();
  const res = await fetch('/api/panitia/update-juknis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compId, juknis })
  });
  const data = await res.json();
  if (data.success) {
    showToast(data.message);
    closeModal('editJuknisModal');
    await loadAndOpenPanitiaDashboard();
  }
}

async function deleteParticipant(id) {
  const res = await fetch('/api/panitia/delete-participant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  const data = await res.json();
  if (data.success) {
    showToast(data.message);
    await loadAndOpenPanitiaDashboard();
  }
}

async function fetchPanitiaAdminsList() {
  const tbody = document.getElementById('panitiaAdminsTableBody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/panitia/list');
    const data = await res.json();
    const list = data.panitia || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 14px; color: var(--muted);">Belum ada akun panitia.</td></tr>`;
      return;
    }
    tbody.innerHTML = list
      .map(
        (p) => `
        <tr>
          <td class="mono" style="font-weight: 700; color: var(--hunter);">${esc(p.id)}</td>
          <td><strong>${esc(p.name)}</strong></td>
          <td><span class="badge badge-brass">${esc(p.role || 'Panitia')}</span></td>
          <td class="mono">${esc(p.password)}</td>
          <td>
            ${
              p.id.toLowerCase() === 'panitia' || (panitiaSession && p.id.toUpperCase() === panitiaSession.id.toUpperCase())
                ? '<span style="font-size: 11px; color: var(--muted); font-style: italic;">Akun Aktif</span>'
                : `<button class="btn btn-danger btn-sm" onclick="deletePanitiaAdmin('${esc(p.id)}')">Hapus</button>`
            }
          </td>
        </tr>
      `
      )
      .join('');
  } catch {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 14px; color: var(--danger);">Gagal memuat daftar panitia.</td></tr>`;
  }
}

async function submitNewPanitiaAdmin(e) {
  e.preventDefault();
  const payload = {
    id: document.getElementById('newPanitiaId').value.trim(),
    name: document.getElementById('newPanitiaName').value.trim(),
    role: document.getElementById('newPanitiaRole').value.trim(),
    password: document.getElementById('newPanitiaPw').value.trim()
  };

  try {
    const res = await fetch('/api/panitia/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Gagal menambahkan akun panitia.', true);
      return;
    }

    showToast(data.message);
    document.getElementById('newPanitiaId').value = '';
    document.getElementById('newPanitiaName').value = '';
    document.getElementById('newPanitiaPw').value = '';
    closeModal('addPanitiaModal');
    await fetchPanitiaAdminsList();
  } catch {
    showToast('Gagal menghubungi server.', true);
  }
}

async function deletePanitiaAdmin(targetId) {
  if (!confirm(`Apakah Anda yakin ingin menghapus akun panitia '${targetId}'?`)) return;
  try {
    const res = await fetch('/api/panitia/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: targetId })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.message || 'Gagal menghapus akun panitia.', true);
      return;
    }

    showToast(data.message);
    await fetchPanitiaAdminsList();
  } catch {
    showToast('Gagal menghubungi server.', true);
  }
}

function downloadExcel() {
  const filter = document.getElementById('excelEventFilter').value;
  const url = filter ? `/api/panitia/export-excel?eventId=${encodeURIComponent(filter)}` : '/api/panitia/export-excel';
  window.location.href = url;
}
