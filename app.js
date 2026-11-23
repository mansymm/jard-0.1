const ACTIVE_STORAGE_KEY = 'factory_inventory_active_v3';
const HISTORY_STORAGE_KEY = 'factory_inventory_history_v3';
const SETTINGS_STORAGE_KEY = 'factory_inventory_settings_v3';
const BATCH_SIZE = 60;

let appSettings = {
  companyName: '',
  outlierThreshold: 50,
  vibrate: true
};

let appState = {
  id: 'inv_' + Date.now(),
  items: [],
  meta: {
    title: '',
    date: getTodayLocalISO(),
    includeDate: true,
    purchase: '',
    purchaseReturn: '',
    sales: '',
    salesReturn: ''
  }
};

let historyList = [];

let uiState = {
  activeTab: 'count',
  search: '',
  status: 'all',
  factory: 'all',
  sort: 'default',
  visibleLimit: BATCH_SIZE
};

let undoStack = [];
let pendingImportRows = [];
let pendingImportHeaders = [];
let nativeStream = null;
let nativeScanInterval = null;
let html5QrInstance = null;

function getTodayLocalISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().split('T')[0];
}

function triggerHaptic(ms = 35) {
  if (appSettings.vibrate && navigator.vibrate) {
    try { navigator.vibrate(ms); } catch (_) {}
  }
}

/* ==========================================================================
   1. التنقل بين الأقسام
   ========================================================================== */
function switchTab(tabName) {
  uiState.activeTab = tabName;
  document.querySelectorAll('.tab-view').forEach(el => {
    el.classList.toggle('active', el.id === 'tab-' + tabName);
  });
  document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  if (tabName === 'history') renderHistoryList();
  if (tabName === 'reports') updateStatsAndProgress();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ==========================================================================
   2. التخزين المحلي
   ========================================================================== */
function saveActiveState() {
  try {
    localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(appState));
  } catch (err) {
    showToast('⚠️ مساحة المتصفح ممتلئة، صدّر نسخة احتياطية JSON');
  }
}

function saveHistoryState() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(historyList));
    updateHistoryBadge();
  } catch (err) {
    showToast('⚠️ تعذر حفظ السجل لامتلاء المساحة');
  }
}

function saveSettingsState() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
  } catch (_) {}
}

function loadAllStorage() {
  try {
    const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (rawSettings) appSettings = { ...appSettings, ...JSON.parse(rawSettings) };
  } catch (_) {}

  try {
    const rawActive = localStorage.getItem(ACTIVE_STORAGE_KEY);
    if (rawActive) {
      const parsed = JSON.parse(rawActive);
      if (parsed && Array.isArray(parsed.items)) {
        appState = {
          id: parsed.id || ('inv_' + Date.now()),
          items: parsed.items,
          meta: { ...appState.meta, ...(parsed.meta || {}) }
        };
      }
    }
  } catch (_) {}

  try {
    const rawHist = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (rawHist) {
      const parsedHist = JSON.parse(rawHist);
      if (Array.isArray(parsedHist)) historyList = parsedHist;
    }
  } catch (_) {}

  updateHistoryBadge();
}

function updateHistoryBadge() {
  const el = document.getElementById('historyCountBadge');
  if (el) el.textContent = historyList.length;
}

/* ==========================================================================
   3. سجل الجرود
   ========================================================================== */
function archiveInventorySnapshot(snapshotObj, autoReason = '') {
  if (!snapshotObj || !Array.isArray(snapshotObj.items) || snapshotObj.items.length === 0) return false;

  const total = snapshotObj.items.length;
  let counted = 0, diffs = 0;
  snapshotObj.items.forEach(itm => {
    const st = getItemStatus(itm);
    if (st.key !== 'uncounted') counted++;
    if (st.key === 'surplus' || st.key === 'shortage') diffs++;
  });

  const recordTitle = (snapshotObj.meta?.title || '').trim() ||
    `جرد بتاريخ ${snapshotObj.meta?.date || getTodayLocalISO()}`;

  const historyEntry = {
    historyId: 'hist_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    savedAt: new Date().toLocaleString('ar-EG'),
    reason: autoReason,
    title: recordTitle,
    summary: { total, counted, diffs },
    data: JSON.parse(JSON.stringify(snapshotObj))
  };

  const existingIdx = historyList.findIndex(h => h.data?.id === snapshotObj.id);
  if (existingIdx !== -1) historyList[existingIdx] = historyEntry;
  else historyList.unshift(historyEntry);

  saveHistoryState();
  return true;
}

function archiveCurrentInventoryManual() {
  if (appState.items.length === 0) return alert('لا يوجد جرد حالي لحفظه في السجل.');
  const customName = prompt(
    'أدخل اسماً مميزاً لحفظ هذا الجرد في السجل:',
    appState.meta.title || `جرد ${appState.meta.date}`
  );
  if (customName === null) return;

  appState.meta.title = customName.trim();
  saveActiveState();
  syncMetaInputs();

  archiveInventorySnapshot(appState, 'حفظ يدوي');
  renderHistoryList();
  showToast('📌 تم حفظ الجرد في السجل بنجاح');
}

function renderHistoryList() {
  const container = document.getElementById('historyListContainer');
  if (historyList.length === 0) {
    container.innerHTML = `<div class="empty-state">لا توجد جرود محفوظة في السجل بعد.<br><small>سيتم حفظ أي جرد تلقائياً هنا عند رفع ملف جديد.</small></div>`;
    return;
  }

  container.innerHTML = historyList.map((entry, idx) => `
    <div class="history-card">
      <div class="history-title">📁 ${escapeHtml(entry.title)}</div>
      <div class="history-meta">
        📅 التاريخ: <strong>${escapeHtml(entry.data?.meta?.date || '—')}</strong> |
        🕒 الحفظ: ${escapeHtml(entry.savedAt)}
      </div>
      <div class="history-meta">
        الأصناف: <strong>${entry.summary.total}</strong> |
        المجرود: <strong class="text-primary">${entry.summary.counted}</strong> |
        الفروقات: <strong class="text-warning">${entry.summary.diffs}</strong>
      </div>
      <div class="history-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick="restoreFromHistory(${idx})">🔄 فتح</button>
        <button type="button" class="btn btn-accent btn-sm" onclick="printHistoryA4(${idx})">🖨️ A4</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="exportHistoryExcel(${idx})">📊 Excel</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteHistoryEntry(${idx})">🗑️ حذف</button>
      </div>
    </div>
  `).join('');
}

function restoreFromHistory(idx) {
  const entry = historyList[idx];
  if (!entry) return;

  if (appState.items.length > 0 && appState.id !== entry.data.id) {
    const ok = confirm('سيتم حفظ الجرد المفتوح حالياً في السجل تلقائياً ثم فتح الجرد المختار. متابعة؟');
    if (!ok) return;
    archiveInventorySnapshot(appState, 'أرشفة تلقائية قبل الاستعادة');
  }

  appState = JSON.parse(JSON.stringify(entry.data));
  undoStack = [];
  document.getElementById('undoBtn').disabled = true;
  uiState = { ...uiState, search: '', status: 'all', factory: 'all', sort: 'default', visibleLimit: BATCH_SIZE };

  saveActiveState();
  syncMetaInputs();
  refreshAllUI();
  switchTab('count');
  showToast(`✅ تم فتح: ${entry.title}`);
}

function deleteHistoryEntry(idx) {
  const entry = historyList[idx];
  if (!entry) return;
  if (!confirm(`هل أنت متأكد من حذف "${entry.title}" نهائياً من السجل؟`)) return;
  historyList.splice(idx, 1);
  saveHistoryState();
  renderHistoryList();
  showToast('🗑️ تم الحذف من السجل');
}

function printHistoryA4(idx) {
  const entry = historyList[idx];
  if (!entry) return;
  generateAndTriggerA4Print(entry.data, 'all', 'all');
}

function exportHistoryExcel(idx) {
  const entry = historyList[idx];
  if (!entry) return;
  buildAndDownloadFullExcel(entry.data, false, 'all');
}

/* ==========================================================================
   4. معالجة الأرقام وحالات الأصناف
   ========================================================================== */
function parseArabicNumber(val) {
  if (val === null || val === undefined || val === '') return NaN;
  if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;

  let str = String(val).trim();
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  str = str.replace(/[٠-٩]/g, d => arabicDigits.indexOf(d))
           .replace(/[۰-۹]/g, d => persianDigits.indexOf(d))
           .replace(/[,،\s]/g, '');

  if (str === '') return NaN;
  const num = Number(str);
  return Number.isFinite(num) ? num : NaN;
}

function getItemStatus(item) {
  if (item.actualQty === null || item.actualQty === undefined || item.actualQty === '') {
    return { key: 'uncounted', label: 'لم يُجرد', diff: null };
  }
  const actual = Number(item.actualQty);
  const sys = Number(item.sysQty) || 0;
  const diff = Number((actual - sys).toFixed(4));

  if (diff === 0) return { key: 'match', label: 'مطابق', diff: 0 };
  if (diff > 0) return { key: 'surplus', label: 'زيادة', diff };
  return { key: 'shortage', label: 'عجز', diff };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ==========================================================================
   5. استيراد ملفات Excel / CSV
   ========================================================================== */
document.getElementById('fileInput').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      const nonEmptyRows = rows.filter(r => Array.isArray(r) && r.some(cell => String(cell).trim() !== ''));
      if (nonEmptyRows.length < 2) {
        alert('الملف فارغ أو لا يحتوي على صفوف بيانات.');
        return;
      }

      pendingImportHeaders = nonEmptyRows[0].map((h, idx) => String(h).trim() || `عمود ${idx + 1}`);
      pendingImportRows = nonEmptyRows.slice(1);
      setupColumnMappingModal();
    } catch (err) {
      alert('تعذر قراءة الملف. تأكد أن صيغته Excel أو CSV صحيحة.');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
});

function setupColumnMappingModal() {
  const codeSel = document.getElementById('mapCodeCol');
  const factorySel = document.getElementById('mapFactoryCol');
  const qtySel = document.getElementById('mapQtyCol');

  const optionsHtml = pendingImportHeaders
    .map((h, i) => `<option value="${i}">${escapeHtml(h)}</option>`)
    .join('');

  codeSel.innerHTML = optionsHtml;
  factorySel.innerHTML = optionsHtml;
  qtySel.innerHTML = optionsHtml;

  let codeIdx = 0;
  let factoryIdx = Math.min(1, pendingImportHeaders.length - 1);
  let qtyIdx = Math.min(2, pendingImportHeaders.length - 1);

  pendingImportHeaders.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (/كود|موديل|صنف|باركود|code|model|sku|item/.test(lower)) codeIdx = i;
    if (/مصنع|مورد|شركة|ماركة|factory|vendor|supplier|brand/.test(lower)) factoryIdx = i;
    if (/كمية|رصيد|الكمية|سيستم|عدد|qty|quantity|stock|balance/.test(lower)) qtyIdx = i;
  });

  codeSel.value = codeIdx;
  factorySel.value = factoryIdx;
  qtySel.value = qtyIdx;

  const checkDuplicates = () => {
    const cIdx = Number(codeSel.value);
    const fIdx = Number(factorySel.value);
    const seen = new Set();
    let dupCount = 0;
    pendingImportRows.forEach(r => {
      const code = String(r[cIdx] ?? '').trim();
      const factory = String(r[fIdx] ?? '').trim() || 'غير محدد';
      if (!code) return;
      const key = `${code.toLowerCase()}||${factory.toLowerCase()}`;
      if (seen.has(key)) dupCount++;
      else seen.add(key);
    });

    const dupBox = document.getElementById('duplicateOptionBox');
    if (dupCount > 0) {
      document.getElementById('duplicateMsg').textContent = `⚠️ يوجد (${dupCount}) صف بأكواد مكررة لنفس المصنع:`;
      dupBox.style.display = 'block';
    } else {
      dupBox.style.display = 'none';
    }
  };

  codeSel.onchange = checkDuplicates;
  factorySel.onchange = checkDuplicates;
  checkDuplicates();
  openModal('columnMappingModal');
}

function confirmImportMapping() {
  const cIdx = Number(document.getElementById('mapCodeCol').value);
  const fIdx = Number(document.getElementById('mapFactoryCol').value);
  const qIdx = Number(document.getElementById('mapQtyCol').value);

  if (cIdx === fIdx || cIdx === qIdx || fIdx === qIdx) {
    alert('يرجى اختيار 3 أعمدة مختلفة لكل من الكود والمصنع والكمية.');
    return;
  }

  const dupAction = document.querySelector('input[name="dupAction"]:checked')?.value || 'merge';
  const importedItems = [];
  const mergeMap = new Map();

  pendingImportRows.forEach((row, index) => {
    const code = String(row[cIdx] ?? '').trim();
    if (!code) return;

    const factory = String(row[fIdx] ?? '').trim() || 'مصنع غير محدد';
    const parsedQty = parseArabicNumber(row[qIdx]);
    const sysQty = Number.isNaN(parsedQty) ? 0 : Math.round(parsedQty * 100) / 100;

    if (dupAction === 'merge') {
      const key = `${code.toLowerCase()}||${factory.toLowerCase()}`;
      if (mergeMap.has(key)) {
        const existing = mergeMap.get(key);
        existing.sysQty = Math.round((existing.sysQty + sysQty) * 100) / 100;
      } else {
        const newItem = {
          id: 'itm_' + Date.now() + '_' + index,
          code,
          factory,
          sysQty,
          actualQty: null,
          note: '',
          isManual: false,
          confirmedOutlier: false
        };
        mergeMap.set(key, newItem);
        importedItems.push(newItem);
      }
    } else {
      importedItems.push({
        id: 'itm_' + Date.now() + '_' + index,
        code,
        factory,
        sysQty,
        actualQty: null,
        note: '',
        isManual: false,
        confirmedOutlier: false
      });
    }
  });

  if (importedItems.length === 0) {
    alert('لم يتم العثور على أصناف صالحة للاستيراد.');
    return;
  }

  let archivedOld = false;
  if (appState.items.length > 0) {
    archivedOld = archiveInventorySnapshot(appState, 'أرشفة تلقائية عند رفع ملف جديد');
  }

  appState = {
    id: 'inv_' + Date.now(),
    items: importedItems,
    meta: {
      title: `جرد ${getTodayLocalISO()}`,
      date: getTodayLocalISO(),
      includeDate: true,
      purchase: '',
      purchaseReturn: '',
      sales: '',
      salesReturn: ''
    }
  };

  undoStack = [];
  document.getElementById('undoBtn').disabled = true;
  uiState = { ...uiState, search: '', status: 'all', factory: 'all', sort: 'default', visibleLimit: BATCH_SIZE };

  saveActiveState();
  syncMetaInputs();
  closeModal('columnMappingModal');
  refreshAllUI();
  switchTab('count');

  showToast(
    archivedOld
      ? `✅ حُفظ الجرد السابق بالسجل وتم استيراد ${importedItems.length} صنف`
      : `✅ تم استيراد ${importedItems.length} صنف بنجاح`
  );
}

/* ==========================================================================
   6. التعديل السريع على الأصناف والتراجع
   ========================================================================== */
function pushUndoSnapshot() {
  try {
    undoStack.push(JSON.stringify(appState.items));
    if (undoStack.length > 20) undoStack.shift();
    document.getElementById('undoBtn').disabled = false;
  } catch (_) {}
}

function undoLastAction() {
  if (undoStack.length === 0) return;
  appState.items = JSON.parse(undoStack.pop());
  document.getElementById('undoBtn').disabled = undoStack.length === 0;
  saveActiveState();
  refreshAllUI();
  showToast('↩ تم التراجع عن آخر تعديل');
}

function stepItemQty(id, delta) {
  const item = appState.items.find(x => x.id === id);
  if (!item) return;

  const current = (item.actualQty === null || item.actualQty === undefined || item.actualQty === '')
    ? 0
    : Number(item.actualQty);
  const nextVal = Math.max(0, Math.round((current + delta) * 100) / 100);

  pushUndoSnapshot();
  item.actualQty = nextVal;
  saveActiveState();

  const inputEl = document.getElementById('qty_' + id);
  if (inputEl) inputEl.value = nextVal;

  updateCardVisuals(item);
  updateStatsAndProgress();
  triggerHaptic(20);
}

function updateItemActualQty(id, rawValue, inputEl) {
  const item = appState.items.find(x => x.id === id);
  if (!item) return;

  const parsed = parseArabicNumber(rawValue);
  const newVal = Number.isNaN(parsed) ? null : parsed;
  if (item.actualQty === newVal) return;

  const threshold = Number(appSettings.outlierThreshold) || 0;
  if (threshold > 0 && newVal !== null && item.sysQty > 0 && !item.confirmedOutlier) {
    const ratioPct = (Math.abs(newVal - item.sysQty) / item.sysQty) * 100;
    if (ratioPct > threshold) {
      const ok = confirm(
        `⚠️ تنبيه فرق أكبر من ${threshold}% للصنف (${item.code}):\n` +
        `كمية السيستم: ${item.sysQty}\nالكمية المدخلة: ${newVal}\n\nهل الرقم صحيح؟`
      );
      if (!ok) {
        if (inputEl) inputEl.value = item.actualQty ?? '';
        return;
      }
      item.confirmedOutlier = true;
    }
  }

  pushUndoSnapshot();
  item.actualQty = newVal;
  saveActiveState();
  updateCardVisuals(item);
  updateStatsAndProgress();
}

function setQuickMatch(id) {
  const item = appState.items.find(x => x.id === id);
  if (!item) return;
  pushUndoSnapshot();
  item.actualQty = item.sysQty;
  saveActiveState();
  const inputEl = document.getElementById('qty_' + id);
  if (inputEl) inputEl.value = item.sysQty;
  updateCardVisuals(item);
  updateStatsAndProgress();
  triggerHaptic(35);
  showToast(`✓ مطابق: ${item.code}`);
}

function updateItemNote(id, noteText) {
  const item = appState.items.find(x => x.id === id);
  if (!item || item.note === noteText) return;
  item.note = noteText;
  saveActiveState();
}

function updateCardVisuals(item) {
  const card = document.getElementById('card_' + item.id);
  if (!card) return;
  const st = getItemStatus(item);

  card.className = `item-card status-${st.key}`;
  const badge = card.querySelector('.status-badge');
  if (badge) {
    badge.className = `status-badge badge-${st.key}`;
    badge.textContent = st.label;
  }

  const diffEl = card.querySelector('.diff-val');
  if (diffEl) {
    if (st.diff === null) {
      diffEl.textContent = '—';
      diffEl.style.color = 'var(--text-muted)';
    } else {
      diffEl.textContent = st.diff > 0 ? `+${st.diff}` : `${st.diff}`;
      diffEl.style.color = st.key === 'shortage' ? 'var(--shortage-border)' :
                           st.key === 'surplus' ? 'var(--surplus-border)' : 'var(--match-border)';
    }
  }
}

function saveManualItem() {
  const code = document.getElementById('manualCodeInput').value.trim();
  const factory = document.getElementById('manualFactoryInput').value.trim() || 'غير محدد';
  const actualParsed = parseArabicNumber(document.getElementById('manualActualInput').value);
  const note = document.getElementById('manualNoteInput').value.trim();

  if (!code) return alert('يرجى إدخال كود الموديل.');
  if (Number.isNaN(actualParsed)) return alert('يرجى إدخال الكمية الفعلية.');

  pushUndoSnapshot();
  appState.items.unshift({
    id: 'man_' + Date.now(),
    code,
    factory,
    sysQty: 0,
    actualQty: actualParsed,
    note,
    isManual: true,
    confirmedOutlier: true
  });

  saveActiveState();
  document.getElementById('manualCodeInput').value = '';
  document.getElementById('manualActualInput').value = '';
  document.getElementById('manualNoteInput').value = '';
  closeModal('addManualModal');
  refreshAllUI();
  showToast(`➕ تمت إضافة الصنف ${code}`);
}

/* ==========================================================================
   7. الفلترة، العرض، والإحصائيات
   ========================================================================== */
function getFilteredAndSortedItems() {
  const query = uiState.search.trim().toLowerCase().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

  let list = appState.items.filter(item => {
    if (uiState.factory !== 'all' && item.factory !== uiState.factory) return false;
    const st = getItemStatus(item);
    if (uiState.status === 'uncounted' && st.key !== 'uncounted') return false;
    if (uiState.status === 'diff' && st.key !== 'surplus' && st.key !== 'shortage') return false;
    if (uiState.status === 'match' && st.key !== 'match') return false;

    if (query) {
      const codeNorm = item.code.toLowerCase().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
      if (!codeNorm.includes(query)) return false;
    }
    return true;
  });

  if (uiState.sort === 'code_asc') {
    list = [...list].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  } else if (uiState.sort === 'biggest_diff') {
    list = [...list].sort((a, b) => Math.abs(getItemStatus(b).diff ?? -1) - Math.abs(getItemStatus(a).diff ?? -1));
  } else if (uiState.sort === 'uncounted_first') {
    list = [...list].sort((a, b) => (getItemStatus(a).key === 'uncounted' ? 0 : 1) - (getItemStatus(b).key === 'uncounted' ? 0 : 1));
  }
  return list;
}

function renderItemsList() {
  const container = document.getElementById('itemsContainer');
  const loadMoreWrap = document.getElementById('loadMoreWrap');
  const filtered = getFilteredAndSortedItems();

  if (appState.items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:2.2rem; margin-bottom:8px;">📋</div>
        <strong>لا يوجد جرد نشط حالياً</strong>
        <p style="font-size:0.84rem; margin:6px 0 12px;">ابدأ برفع ملف السيستم من الإعدادات أو افتح جرداً من السجل.</p>
        <button type="button" class="btn btn-primary btn-sm" onclick="switchTab('settings')">⚙️ الذهاب للإعدادات ورفع ملف</button>
      </div>`;
    loadMoreWrap.style.display = 'none';
    return;
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><strong>لا توجد نتائج مطابقة للبحث أو الفلتر الحالي</strong></div>`;
    loadMoreWrap.style.display = 'none';
    return;
  }

  const slice = filtered.slice(0, uiState.visibleLimit);
  container.innerHTML = slice.map(item => {
    const st = getItemStatus(item);
    const diffDisplay = st.diff === null ? '—' : (st.diff > 0 ? `+${st.diff}` : `${st.diff}`);
    const diffColor = st.key === 'shortage' ? 'var(--shortage-border)' :
                      st.key === 'surplus' ? 'var(--surplus-border)' :
                      st.key === 'match' ? 'var(--match-border)' : 'var(--text-muted)';

    return `
      <article class="item-card status-${st.key}" id="card_${item.id}">
        <div class="card-header">
          <div>
            <span class="model-code">${escapeHtml(item.code)}</span>
            ${item.isManual ? '<span class="manual-tag">غير موجود بالسيستم</span>' : ''}
            <div><span class="factory-tag">🏭 ${escapeHtml(item.factory)}</span></div>
          </div>
          <span class="status-badge badge-${st.key}">${st.label}</span>
        </div>

        <div class="qty-row">
          <div class="qty-box">
            <span class="lbl">السيستم</span>
            <strong class="val">${item.sysQty}</strong>
          </div>

          <div class="stepper-wrap">
            <button type="button" class="step-btn" onclick="stepItemQty('${item.id}', -1)" aria-label="ناقص 1">−</button>
            <input
              type="text"
              inputmode="decimal"
              id="qty_${item.id}"
              class="actual-input"
              placeholder="الفعلي"
              value="${item.actualQty !== null && item.actualQty !== undefined ? item.actualQty : ''}"
              onchange="updateItemActualQty('${item.id}', this.value, this)"
              onkeydown="if(event.key==='Enter'){ this.blur(); }"
            />
            <button type="button" class="step-btn" onclick="stepItemQty('${item.id}', 1)" aria-label="زائد 1">+</button>
            <button type="button" class="step-btn match-btn" onclick="setQuickMatch('${item.id}')" title="مطابق للسيستم">✓</button>
          </div>

          <div class="qty-box">
            <span class="lbl">الفرق</span>
            <strong class="val diff-val" style="color:${diffColor}">${diffDisplay}</strong>
          </div>
        </div>

        <input
          type="text"
          class="note-input"
          placeholder="📝 ملحوظة..."
          value="${escapeHtml(item.note)}"
          onchange="updateItemNote('${item.id}', this.value)"
        />
      </article>
    `;
  }).join('');

  if (filtered.length > uiState.visibleLimit) {
    loadMoreWrap.style.display = 'block';
    document.getElementById('loadMoreBtn').textContent = `عرض المزيد (متبقي ${filtered.length - uiState.visibleLimit} صنف)...`;
  } else {
    loadMoreWrap.style.display = 'none';
  }
}

function loadMoreItems() {
  uiState.visibleLimit += BATCH_SIZE;
  renderItemsList();
}

function updateStatsAndProgress() {
  const total = appState.items.length;
  let counted = 0, diffCount = 0;
  const factoryMap = new Map();

  appState.items.forEach(item => {
    const st = getItemStatus(item);
    const isCounted = st.key !== 'uncounted';
    if (isCounted) counted++;
    if (st.key === 'surplus' || st.key === 'shortage') diffCount++;

    if (!factoryMap.has(item.factory)) factoryMap.set(item.factory, { total: 0, counted: 0, diff: 0 });
    const fStat = factoryMap.get(item.factory);
    fStat.total++;
    if (isCounted) fStat.counted++;
    if (st.key === 'surplus' || st.key === 'shortage') fStat.diff++;
  });

  const pct = total > 0 ? Math.round((counted / total) * 100) : 0;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statCounted').textContent = counted;
  document.getElementById('statDiff').textContent = diffCount;
  document.getElementById('statRemaining').textContent = total - counted;
  document.getElementById('overallProgressBar').style.width = pct + '%';
  document.getElementById('overallProgressText').textContent = pct + '%';

  const factories = Array.from(factoryMap.keys()).sort((a, b) => a.localeCompare(b, 'ar'));
  const optionsHtml = factories.map(f => {
    const fs = factoryMap.get(f);
    const fPct = fs.total > 0 ? Math.round((fs.counted / fs.total) * 100) : 0;
    return `<option value="${escapeHtml(f)}">${escapeHtml(f)} (${fPct}%)</option>`;
  }).join('');

  const factorySelect = document.getElementById('factoryFilter');
  const currentVal = uiState.factory;
  factorySelect.innerHTML = `<option value="all">🏭 كل المصانع (${factories.length})</option>` + optionsHtml;
  if (factories.includes(currentVal)) factorySelect.value = currentVal;
  else { uiState.factory = 'all'; factorySelect.value = 'all'; }

  const reportFactorySelect = document.getElementById('reportFactorySelect');
  const prevRepVal = reportFactorySelect.value;
  reportFactorySelect.innerHTML = `<option value="all">اختر المصنع للتصدير...</option>` + optionsHtml;
  if (factories.includes(prevRepVal)) reportFactorySelect.value = prevRepVal;
  document.getElementById('exportSelectedFactoryBtn').disabled = reportFactorySelect.value === 'all';

  document.getElementById('factoriesDatalist').innerHTML =
    factories.map(f => `<option value="${escapeHtml(f)}">`).join('');

  const fpContainer = document.getElementById('factoryProgressContainer');
  fpContainer.innerHTML = factories.length === 0
    ? '<p class="section-desc" style="text-align:center;">لا توجد مصانع محمّلة بعد.</p>'
    : factories.map(f => {
        const fs = factoryMap.get(f);
        const fPct = fs.total > 0 ? Math.round((fs.counted / fs.total) * 100) : 0;
        return `
          <div class="fp-item">
            <div class="fp-top">
              <span>🏭 ${escapeHtml(f)}</span>
              <span>${fs.counted} / ${fs.total} (${fPct}%)</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${fPct}%"></div></div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">
              فروقات: <strong class="text-warning">${fs.diff}</strong> | متبقي: <strong>${fs.total - fs.counted}</strong>
            </div>
          </div>`;
      }).join('');
}

function refreshAllUI() {
  updateStatsAndProgress();
  renderItemsList();
}

/* ==========================================================================
   8. الطباعة المباشرة A4 ومشاركة واتساب
   ========================================================================== */
function printA4Report(mode) {
  if (appState.items.length === 0) return alert('لا توجد أصناف للطباعة.');
  generateAndTriggerA4Print(appState, mode, uiState.factory);
}

function generateAndTriggerA4Print(stateObj, mode = 'all', selectedFactory = 'all') {
  let targetItems = stateObj.items;
  let scopeTitle = 'جميع المصانع';

  if (selectedFactory && selectedFactory !== 'all') {
    targetItems = targetItems.filter(x => x.factory === selectedFactory);
    scopeTitle = `مصنع: ${selectedFactory}`;
  }

  if (mode === 'diff') {
    targetItems = targetItems.filter(x => ['surplus', 'shortage'].includes(getItemStatus(x).key));
  }

  if (targetItems.length === 0) return alert('لا توجد أصناف مطابقة لخيار الطباعة المحدد.');

  const m = stateObj.meta || {};
  const companyHeader = appSettings.companyName ? `<div class="a4-company">${escapeHtml(appSettings.companyName)}</div>` : '';
  const reportTitle = (m.title || 'تقرير جرد المخزون') + (mode === 'diff' ? ' (كشف الفروقات فقط)' : '');
  const dateDisplay = m.includeDate ? (m.date || getTodayLocalISO()) : '—';

  let totalSys = 0, totalAct = 0, diffCount = 0;

  const rowsHtml = targetItems.map((item, idx) => {
    const st = getItemStatus(item);
    totalSys += Number(item.sysQty) || 0;
    if (item.actualQty !== null && item.actualQty !== undefined) totalAct += Number(item.actualQty);
    if (st.key === 'surplus' || st.key === 'shortage') diffCount++;

    const rowClass = st.key === 'shortage' ? 'a4-row-shortage' : (st.key === 'surplus' ? 'a4-row-surplus' : '');
    const diffStr = st.diff === null ? '—' : (st.diff > 0 ? `+${st.diff}` : `${st.diff}`);
    const actStr = item.actualQty !== null && item.actualQty !== undefined ? item.actualQty : '—';
    const noteStr = item.isManual ? `[غير مسجل بالسيستم] ${item.note || ''}` : (item.note || '');

    return `
      <tr class="${rowClass}">
        <td>${idx + 1}</td>
        <td dir="ltr" style="font-weight:700;">${escapeHtml(item.code)}</td>
        <td>${escapeHtml(item.factory)}</td>
        <td>${item.sysQty}</td>
        <td style="font-weight:700;">${actStr}</td>
        <td dir="ltr" style="font-weight:800;">${diffStr}</td>
        <td>${st.label}</td>
        <td style="text-align:right;">${escapeHtml(noteStr)}</td>
      </tr>
    `;
  }).join('');

  const printArea = document.getElementById('printArea');
  printArea.innerHTML = `
    <div class="a4-header">
      <div>
        ${companyHeader}
        <h1 class="a4-title">📦 ${escapeHtml(reportTitle)}</h1>
        <div>النطاق: <strong>${escapeHtml(scopeTitle)}</strong> | عدد الأصناف: <strong>${targetItems.length}</strong> | الفروقات: <strong>${diffCount}</strong></div>
      </div>
      <div style="text-align:left; font-size:9.5pt;">
        <div>تاريخ الجرد: <strong>${escapeHtml(dateDisplay)}</strong></div>
        <div>تاريخ الطباعة: ${new Date().toLocaleDateString('ar-EG')}</div>
      </div>
    </div>

    <div class="a4-meta-grid">
      <div>آخر فاتورة مشتريات: <strong>${escapeHtml(m.purchase || '—')}</strong></div>
      <div>آخر مردود مشتريات: <strong>${escapeHtml(m.purchaseReturn || '—')}</strong></div>
      <div>إجمالي كمية السيستم: <strong>${Math.round(totalSys * 100) / 100}</strong></div>
      <div>آخر فاتورة مبيعات: <strong>${escapeHtml(m.sales || '—')}</strong></div>
      <div>آخر مردود مبيعات: <strong>${escapeHtml(m.salesReturn || '—')}</strong></div>
      <div>إجمالي الكمية الفعلية: <strong>${Math.round(totalAct * 100) / 100}</strong></div>
    </div>

    <table class="a4-table">
      <thead>
        <tr>
          <th style="width:5%;">#</th>
          <th style="width:16%;">كود الموديل</th>
          <th style="width:16%;">المصنع</th>
          <th style="width:10%;">السيستم</th>
          <th style="width:10%;">الفعلي</th>
          <th style="width:10%;">الفرق</th>
          <th style="width:11%;">الحالة</th>
          <th style="width:22%;">الملحوظات</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="a4-signatures">
      <div>أمين المخزن / القائم بالجرد<div class="a4-sig-line">التوقيع</div></div>
      <div>مراجع الحسابات<div class="a4-sig-line">التوقيع</div></div>
      <div>مدير المصنع / المكتب<div class="a4-sig-line">التوقيع</div></div>
    </div>
  `;

  setTimeout(() => window.print(), 150);
}

function copyWhatsAppSummary() {
  if (appState.items.length === 0) return alert('لا توجد بيانات لمشاركتها.');
  const total = appState.items.length;
  let counted = 0, shortage = 0, surplus = 0;
  appState.items.forEach(i => {
    const k = getItemStatus(i).key;
    if (k !== 'uncounted') counted++;
    if (k === 'shortage') shortage++;
    if (k === 'surplus') surplus++;
  });
  const m = appState.meta;
  const lines = [
    `📦 *ملخص جرد المخزون* ${appSettings.companyName ? `(${appSettings.companyName})` : ''}`,
    `📅 التاريخ: ${m.date || getTodayLocalISO()}`,
    `• إجمالي الأصناف: ${total}`,
    `• تم جرده: ${counted} (${Math.round((counted / total) * 100)}%)`,
    `• أصناف بعجز: ${shortage} | أصناف بزيادة: ${surplus}`,
    m.purchase ? `• آخر فاتورة مشتريات: ${m.purchase}` : '',
    m.sales ? `• آخر فاتورة مبيعات: ${m.sales}` : ''
  ].filter(Boolean).join('\n');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(lines).then(() => showToast('📋 تم نسخ الملخص، جاهز للصق في واتساب'));
  } else {
    prompt('انسخ الملخص التالي:', lines);
  }
}

/* ==========================================================================
   9. تصدير تقارير Excel والملفات (متوافق مع المتصفح و Capacitor Android APK)
   ========================================================================== */
function buildInventorySheet(itemsList) {
  const headers = ['كود الموديل', 'المصنع', 'كمية السيستم', 'الكمية الفعلية', 'الفرق', 'الحالة', 'الملحوظات'];

  const rows = itemsList.map(item => {
    const st = getItemStatus(item);
    const noteFull = item.isManual
      ? (item.note ? `[غير موجود بالسيستم] ${item.note}` : 'غير موجود بالسيستم')
      : (item.note || '');
    return [
      item.code,
      item.factory,
      Number(item.sysQty) || 0,
      item.actualQty !== null && item.actualQty !== undefined ? Number(item.actualQty) : '',
      st.diff !== null ? st.diff : '',
      st.label,
      noteFull
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!views'] = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  if (rows.length > 0) ws['!autofilter'] = { ref: `A1:G${rows.length + 1}` };
  ws['!cols'] = [{ wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 32 }];

  for (let c = 0; c < headers.length; c++) {
    const hCell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (hCell) {
      hCell.s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '0F766E' } },
        alignment: { horizontal: 'center' }
      };
    }
  }

  rows.forEach((r, idx) => {
    const rowNum = idx + 1;
    const statusLabel = r[5];
    let fillRgb = statusLabel === 'عجز' ? 'FEE2E2' : (statusLabel === 'زيادة' ? 'FFEDD5' : null);
    if (fillRgb) {
      [4, 5].forEach(colIdx => {
        const cellRef = XLSX.utils.encode_cell({ r: rowNum, c: colIdx });
        if (ws[cellRef]) ws[cellRef].s = { fill: { fgColor: { rgb: fillRgb } }, font: { bold: true } };
      });
    }
  });

  return ws;
}

function buildMetaSheet(metaObj, scopeName) {
  const m = metaObj || {};
  const data = [
    ['بيانات الجرد', 'القيمة'],
    ['اسم المكتب / المصنع', appSettings.companyName || '—'],
    ['عنوان الجرد', m.title || '—'],
    ['نطاق التقرير', scopeName],
    ['تاريخ الجرد', m.includeDate ? (m.date || getTodayLocalISO()) : 'غير مسجل بالتقرير'],
    ['آخر رقم فاتورة مشتريات', m.purchase || '—'],
    ['آخر رقم فاتورة مردود مشتريات', m.purchaseReturn || '—'],
    ['آخر رقم فاتورة مبيعات', m.sales || '—'],
    ['آخر رقم فاتورة مردود مبيعات', m.salesReturn || '—']
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!views'] = [{ rightToLeft: true }];
  ws['!cols'] = [{ wch: 28 }, { wch: 28 }];
  return ws;
}

function sanitizeSheetName(rawName, usedNamesSet) {
  let clean = String(rawName || 'مصنع').replace(/[\\\/\?\*\[\]\:]/g, '-').trim() || 'مصنع';
  clean = clean.slice(0, 31);
  let finalName = clean;
  let counter = 2;
  while (usedNamesSet.has(finalName.toLowerCase())) {
    const suffix = `_${counter}`;
    finalName = clean.slice(0, 31 - suffix.length) + suffix;
    counter++;
  }
  usedNamesSet.add(finalName.toLowerCase());
  return finalName;
}

// دالة موحدة لتنزيل الملفات تعمل في المتصفح العادي وداخل تطبيق Android APK
async function saveOrShareFile(base64Data, blobObj, filename) {
  try {
    // إذا كان التطبيق يعمل داخل Capacitor APK وتتوفر إضافتا Filesystem و Share
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      const { Filesystem, Share } = window.Capacitor.Plugins || {};
      if (Filesystem && Share) {
        const res = await Filesystem.writeFile({
          path: filename,
          data: base64Data,
          directory: 'CACHE'
        });
        await Share.share({
          title: filename,
          url: res.uri
        });
        return;
      }
    }
  } catch (e) {
    console.warn('Capacitor native share fallback:', e);
  }

  // التنزيل القياسي في المتصفح
  const url = URL.createObjectURL(blobObj);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 600);
}

function downloadWorkbookAsBlob(wb, filename) {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
  const base64Str = XLSX.write(wb, { bookType: 'xlsx', type: 'base64', cellStyles: true });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveOrShareFile(base64Str, blob, filename);
}

function exportMainExcelReport(onlySelectedFactory) {
  if (appState.items.length === 0) return alert('لا توجد بيانات لتصديرها.');
  buildAndDownloadFullExcel(appState, onlySelectedFactory, uiState.factory);
}

function exportSelectedFactoryFromReports() {
  const sel = document.getElementById('reportFactorySelect').value;
  if (!sel || sel === 'all') return;
  buildAndDownloadFullExcel(appState, true, sel);
}

function buildAndDownloadFullExcel(stateObj, onlySelectedFactory, selectedFactoryName) {
  let targetItems = stateObj.items;
  let scopeLabel = 'جميع المصانع';
  let fileFactoryPart = '';

  if (onlySelectedFactory && selectedFactoryName && selectedFactoryName !== 'all') {
    targetItems = targetItems.filter(x => x.factory === selectedFactoryName);
    scopeLabel = selectedFactoryName;
    fileFactoryPart = '_' + selectedFactoryName.replace(/[\\\/\?\*\[\]\:\s]+/g, '-');
  }

  const diffItems = targetItems.filter(x => ['surplus', 'shortage'].includes(getItemStatus(x).key));
  const uncountedItems = targetItems.filter(x => getItemStatus(x).key === 'uncounted');

  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };

  XLSX.utils.book_append_sheet(wb, buildMetaSheet(stateObj.meta, scopeLabel), 'بيانات الجرد');
  XLSX.utils.book_append_sheet(wb, buildInventorySheet(targetItems), 'الجرد الكامل');
  XLSX.utils.book_append_sheet(wb, buildInventorySheet(diffItems), 'الفروقات');
  XLSX.utils.book_append_sheet(wb, buildInventorySheet(uncountedItems), 'لم يُجرد');

  const dateStr = stateObj.meta?.date || getTodayLocalISO();
  downloadWorkbookAsBlob(wb, `تقرير_جرد${fileFactoryPart}_${dateStr}.xlsx`);
  showToast('📥 تم تجهيز ملف Excel');
}

function exportPerFactoryExcel() {
  if (appState.items.length === 0) return alert('لا توجد بيانات لتصديرها.');

  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  const usedNames = new Set();

  XLSX.utils.book_append_sheet(wb, buildMetaSheet(appState.meta, 'تفصيلي لكل مصنع'), sanitizeSheetName('بيانات الجرد', usedNames));

  const grouped = new Map();
  appState.items.forEach(item => {
    if (!grouped.has(item.factory)) grouped.set(item.factory, []);
    grouped.get(item.factory).push(item);
  });

  grouped.forEach((items, factoryName) => {
    XLSX.utils.book_append_sheet(wb, buildInventorySheet(items), sanitizeSheetName(factoryName, usedNames));
  });

  const allDiffs = appState.items.filter(x => ['surplus', 'shortage'].includes(getItemStatus(x).key));
  XLSX.utils.book_append_sheet(wb, buildInventorySheet(allDiffs), sanitizeSheetName('كل الفروقات', usedNames));

  const dateStr = appState.meta?.date || getTodayLocalISO();
  downloadWorkbookAsBlob(wb, `جرد_المصانع_تفصيلي_${dateStr}.xlsx`);
  showToast('📑 تم تجهيز ملف شيتات المصانع');
}

/* ==========================================================================
   10. النسخة الاحتياطية JSON وإعادة الضبط
   ========================================================================== */
function exportFullBackupJSON() {
  const fullPayload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    settings: appSettings,
    activeInventory: appState,
    history: historyList
  };
  const dateStr = appState.meta.date || getTodayLocalISO();
  const jsonStr = JSON.stringify(fullPayload, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const base64Str = btoa(unescape(encodeURIComponent(jsonStr)));
  saveOrShareFile(base64Str, blob, `نسخة_احتياطية_جرد_وسجل_${dateStr}.json`);
  showToast('💾 تم تجهيز النسخة الاحتياطية');
}

document.getElementById('backupInput').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const parsed = JSON.parse(evt.target.result);
      if (parsed && parsed.activeInventory) {
        if (!confirm('سيتم استعادة الجرد الحالي وسجل الجرود والإعدادات من الملف. هل تريد المتابعة؟')) return;
        appState = parsed.activeInventory;
        if (Array.isArray(parsed.history)) historyList = parsed.history;
        if (parsed.settings) appSettings = { ...appSettings, ...parsed.settings };
      } else if (parsed && Array.isArray(parsed.items)) {
        if (!confirm(`سيتم استعادة (${parsed.items.length}) صنف من النسخة الاحتياطية. هل تريد المتابعة؟`)) return;
        appState = { id: 'inv_' + Date.now(), items: parsed.items, meta: { ...appState.meta, ...(parsed.meta || {}) } };
      } else {
        return alert('ملف النسخة الاحتياطية غير صالح.');
      }

      saveActiveState();
      saveHistoryState();
      saveSettingsState();
      syncMetaInputs();
      refreshAllUI();
      showToast('✅ تمت استعادة النسخة الاحتياطية بنجاح');
    } catch (err) {
      alert('تعذر قراءة ملف JSON.');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

function confirmResetAll() {
  if (appState.items.length === 0) return alert('الشاشة فارغة بالفعل.');
  const ok = confirm('سيتم حفظ الجرد الحالي في "سجل الجرود" أولاً ثم تفريغ الشاشة لبدء جرد جديد.\nهل تريد المتابعة؟');
  if (!ok) return;

  archiveInventorySnapshot(appState, 'أرشفة عند بدء جرد جديد');

  appState = {
    id: 'inv_' + Date.now(),
    items: [],
    meta: {
      title: '',
      date: getTodayLocalISO(),
      includeDate: true,
      purchase: '',
      purchaseReturn: '',
      sales: '',
      salesReturn: ''
    }
  };
  undoStack = [];
  document.getElementById('undoBtn').disabled = true;
  uiState = { ...uiState, search: '', status: 'all', factory: 'all', sort: 'default', visibleLimit: BATCH_SIZE };
  saveActiveState();
  syncMetaInputs();
  refreshAllUI();
  switchTab('count');
  showToast('📌 تم حفظ الجرد في السجل وبدء جرد جديد');
}

/* ==========================================================================
   11. قارئ الباركود بالكاميرا
   ========================================================================== */
async function openBarcodeScanner() {
  openModal('scannerModal');
  const statusEl = document.getElementById('scannerStatusText');
  const videoEl = document.getElementById('nativeVideo');
  const html5El = document.getElementById('html5QrReader');

  videoEl.style.display = 'none';
  html5El.innerHTML = '';

  if ('BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      nativeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      videoEl.srcObject = nativeStream;
      videoEl.style.display = 'block';
      await videoEl.play();

      const detector = new BarcodeDetector();
      statusEl.textContent = 'وجّه الكاميرا نحو الباركود...';

      nativeScanInterval = setInterval(async () => {
        if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
          try {
            const barcodes = await detector.detect(videoEl);
            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
              handleBarcodeScanned(barcodes[0].rawValue);
            }
          } catch (_) {}
        }
      }, 250);
      return;
    } catch (_) {
      stopNativeCameraOnly();
    }
  }

  if (typeof Html5Qrcode !== 'undefined') {
    try {
      html5QrInstance = new Html5Qrcode('html5QrReader');
      await html5QrInstance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 140 } },
        (decodedText) => { if (decodedText) handleBarcodeScanned(decodedText); },
        () => {}
      );
      statusEl.textContent = 'وجّه الكاميرا نحو الباركود...';
    } catch (_) {
      statusEl.textContent = '⚠️ تعذر فتح الكاميرا. تأكد من منح الإذن للتطبيق.';
    }
  }
}

function stopNativeCameraOnly() {
  if (nativeScanInterval) { clearInterval(nativeScanInterval); nativeScanInterval = null; }
  if (nativeStream) { nativeStream.getTracks().forEach(t => t.stop()); nativeStream = null; }
  const videoEl = document.getElementById('nativeVideo');
  if (videoEl) { videoEl.srcObject = null; videoEl.style.display = 'none'; }
}

async function stopBarcodeScanner() {
  stopNativeCameraOnly();
  if (html5QrInstance) {
    try { await html5QrInstance.stop(); html5QrInstance.clear(); } catch (_) {}
    html5QrInstance = null;
  }
  closeModal('scannerModal');
}

function handleBarcodeScanned(scannedCode) {
  const cleanCode = String(scannedCode).trim();
  stopBarcodeScanner();
  triggerHaptic(60);

  switchTab('count');
  const searchInput = document.getElementById('searchInput');
  searchInput.value = cleanCode;
  uiState.search = cleanCode;
  uiState.status = 'all';
  uiState.factory = 'all';
  updateStatusPillsUI();
  refreshAllUI();

  const exactItem = appState.items.find(x => x.code.toLowerCase() === cleanCode.toLowerCase()) ||
                    appState.items.find(x => x.code.toLowerCase().includes(cleanCode.toLowerCase()));

  if (exactItem) {
    showToast(`📷 تم قراءة: ${exactItem.code}`);
    setTimeout(() => {
      const qtyField = document.getElementById('qty_' + exactItem.id);
      if (qtyField) {
        qtyField.scrollIntoView({ behavior: 'smooth', block: 'center' });
        qtyField.focus();
        qtyField.select();
      }
    }, 120);
  } else if (confirm(`الكود (${cleanCode}) غير موجود بالسيستم.\nهل تريد إضافته كصنف جديد؟`)) {
    document.getElementById('manualCodeInput').value = cleanCode;
    openModal('addManualModal');
    setTimeout(() => document.getElementById('manualActualInput').focus(), 100);
  }
}

/* ==========================================================================
   12. التهيئة وربط الأحداث
   ========================================================================== */
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function updateStatusPillsUI() {
  document.querySelectorAll('#statusFilterGroup .chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === uiState.status);
  });
}

function syncMetaInputs() {
  document.getElementById('inventoryTitle').value = appState.meta.title || '';
  document.getElementById('inventoryDate').value = appState.meta.date || getTodayLocalISO();
  document.getElementById('includeDateInReport').checked = !!appState.meta.includeDate;
  document.getElementById('invPurchase').value = appState.meta.purchase || '';
  document.getElementById('invPurchaseReturn').value = appState.meta.purchaseReturn || '';
  document.getElementById('invSales').value = appState.meta.sales || '';
  document.getElementById('invSalesReturn').value = appState.meta.salesReturn || '';

  document.getElementById('settingCompanyName').value = appSettings.companyName || '';
  document.getElementById('settingOutlierThreshold').value = String(appSettings.outlierThreshold ?? 50);
  document.getElementById('settingVibrate').checked = !!appSettings.vibrate;

  document.getElementById('headerCompanyTitle').textContent = appSettings.companyName || 'جرد المخزون';
  document.getElementById('headerInvSubtitle').textContent = appState.meta.title || `تاريخ: ${appState.meta.date || getTodayLocalISO()}`;
}

function setupEventListeners() {
  const metaBindings = [
    ['inventoryTitle', 'title', 'value'],
    ['inventoryDate', 'date', 'value'],
    ['includeDateInReport', 'includeDate', 'checked'],
    ['invPurchase', 'purchase', 'value'],
    ['invPurchaseReturn', 'purchaseReturn', 'value'],
    ['invSales', 'sales', 'value'],
    ['invSalesReturn', 'salesReturn', 'value']
  ];

  metaBindings.forEach(([elId, key, prop]) => {
    document.getElementById(elId).addEventListener('change', (e) => {
      appState.meta[key] = e.target[prop];
      saveActiveState();
      syncMetaInputs();
    });
  });

  document.getElementById('settingCompanyName').addEventListener('input', (e) => {
    appSettings.companyName = e.target.value;
    saveSettingsState();
    document.getElementById('headerCompanyTitle').textContent = appSettings.companyName || 'جرد المخزون';
  });

  document.getElementById('settingOutlierThreshold').addEventListener('change', (e) => {
    appSettings.outlierThreshold = Number(e.target.value);
    saveSettingsState();
  });

  document.getElementById('settingVibrate').addEventListener('change', (e) => {
    appSettings.vibrate = e.target.checked;
    saveSettingsState();
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    uiState.search = e.target.value;
    uiState.visibleLimit = BATCH_SIZE;
    renderItemsList();
  });

  document.querySelectorAll('#statusFilterGroup .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      uiState.status = btn.dataset.status;
      uiState.visibleLimit = BATCH_SIZE;
      updateStatusPillsUI();
      renderItemsList();
    });
  });

  document.getElementById('factoryFilter').addEventListener('change', (e) => {
    uiState.factory = e.target.value;
    uiState.visibleLimit = BATCH_SIZE;
    refreshAllUI();
  });

  document.getElementById('reportFactorySelect').addEventListener('change', (e) => {
    document.getElementById('exportSelectedFactoryBtn').disabled = e.target.value === 'all';
  });

  document.getElementById('sortSelect').addEventListener('change', (e) => {
    uiState.sort = e.target.value;
    uiState.visibleLimit = BATCH_SIZE;
    renderItemsList();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadAllStorage();
  syncMetaInputs();
  setupEventListeners();
  refreshAllUI();

  if (appState.items.length === 0) {
    switchTab('settings');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
