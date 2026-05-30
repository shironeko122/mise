(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    config: null,
    albumId: albumIdFromPath(),
    pin: '',
    album: null,
    timer: null,
    refreshTimer: null
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    try {
      const cfg = await api('/api/config');
      state.config = cfg;
      $('versionBadge').textContent = `v${cfg.version}`;
      renderAccessGuide(cfg);
    } catch (_) {
      $('versionBadge').textContent = 'offline?';
    }

    if (state.albumId) {
      $('albumView').classList.remove('hidden');
      const savedPin = sessionStorage.getItem(pinKey(state.albumId));
      if (savedPin) {
        $('pinInput').value = savedPin;
        state.pin = savedPin;
        await loadAlbum(true);
      }
    } else {
      $('homeView').classList.remove('hidden');
    }
  }


  function renderAccessGuide(cfg) {
    const box = $('accessGuide');
    if (!box || !cfg || !cfg.accessUrls) return;
    const urls = Array.isArray(cfg.accessUrls.lan) ? cfg.accessUrls.lan : [];
    const current = cfg.accessUrls.current || location.origin;
    const lines = [];
    lines.push(`<strong>PC側の起動URL：</strong> <code>${escapeHtml(location.origin)}</code>`);
    if (urls.length) {
      lines.push(`<strong>iPhone同じWi-Fi用：</strong> ${urls.map((u) => `<code>${escapeHtml(u)}</code>`).join(' / ')}`);
      lines.push('QRコードは、PCでlocalhostを開いていても同じWi-Fi内のiPhoneから届きやすいLAN用URLを優先します。');
    } else {
      lines.push('LAN用URLを自動検出できませんでした。同じWi-Fiで使う場合はPCのIPアドレスを確認してください。');
    }
    if (cfg.accessUrls.publicBaseUrl) {
      lines.push(`<strong>一時公開URL：</strong> <code>${escapeHtml(cfg.accessUrls.publicBaseUrl)}</code>`);
    } else if (!urls.length && current) {
      lines.push(`<strong>現在の共有URL基準：</strong> <code>${escapeHtml(current)}</code>`);
    }
    box.innerHTML = lines.map((line) => `<p>${line}</p>`).join('');
    box.classList.remove('hidden');
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function bindEvents() {
    $('createForm').addEventListener('submit', createAlbum);
    $('unlockButton').addEventListener('click', () => unlock(false));
    $('pinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlock(false);
    });
    $('photoInput').addEventListener('change', updateSelectedText);
    $('uploadForm').addEventListener('submit', uploadPhotos);
    $('downloadButton').addEventListener('click', downloadZip);
    $('refreshButton').addEventListener('click', () => loadAlbum(false));
    $('deleteButton').addEventListener('click', deleteAlbum);
    $('copyUrlButton').addEventListener('click', copyAlbumUrl);
  }

  function albumIdFromPath() {
    const match = location.pathname.match(/^\/a\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function pinKey(albumId) {
    return `iphonePhotoBridge.pin.${albumId}`;
  }

  async function createAlbum(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name') || '').trim(),
      pin: String(form.get('pin') || '').trim()
    };
    setBusy(event.submitter, true);
    try {
      const result = await api('/api/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const album = result.album;
      const pin = result.pinGenerated ? result.pin : body.pin;
      if (pin) sessionStorage.setItem(pinKey(album.id), pin);
      if (result.pinGenerated) {
        alert(`PINを自動生成しました。\n\nPIN: ${pin}\n\nPC側でもiPhone側でもこのPINを使います。`);
      }
      location.href = `/a/${encodeURIComponent(album.id)}`;
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy(event.submitter, false);
    }
  }

  async function unlock(silent) {
    state.pin = $('pinInput').value.trim();
    if (!state.pin) {
      if (!silent) showToast('PINを入力してください。', true);
      return;
    }
    await loadAlbum(silent);
  }

  async function loadAlbum(silent) {
    if (!state.albumId || !state.pin) return;
    try {
      const result = await api(`/api/albums/${encodeURIComponent(state.albumId)}`, {
        headers: { 'X-Album-Pin': state.pin }
      });
      state.album = result.album;
      sessionStorage.setItem(pinKey(state.albumId), state.pin);
      renderAlbum();
      if (!silent) showToast('最新情報を取得しました。');
    } catch (err) {
      if (!silent) showToast(err.message, true);
      $('pinBox').classList.remove('hidden');
      $('albumTools').classList.add('hidden');
    }
  }

  function renderAlbum() {
    const album = state.album;
    $('albumTitle').textContent = album.name;
    $('albumMeta').textContent = `${album.fileCount}枚 / ${formatBytes(album.totalBytes)} / 期限: ${formatDate(album.expiresAt)}`;
    $('pinBox').classList.add('hidden');
    $('albumTools').classList.remove('hidden');
    $('qrImage').src = album.qrUrl;
    $('albumUrl').value = album.albumUrl;
    $('fileSummary').textContent = `${album.fileCount}枚 / ${formatBytes(album.totalBytes)}`;
    renderFiles(album.files || []);
    startCountdown();
    startAutoRefresh();
  }

  function renderFiles(files) {
    const list = $('fileList');
    list.innerHTML = '';
    if (!files.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="fileName">まだ画像はありません。</span><span class="fileSize">0 B</span>';
      list.appendChild(li);
      return;
    }
    for (const file of files.slice().reverse()) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'fileName';
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'fileSize';
      size.textContent = formatBytes(file.size);
      li.appendChild(name);
      li.appendChild(size);
      list.appendChild(li);
    }
  }

  function updateSelectedText() {
    const files = Array.from($('photoInput').files || []);
    if (!files.length) {
      $('selectedText').textContent = '未選択です。';
      return;
    }
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    $('selectedText').textContent = `${files.length}枚選択中 / ${formatBytes(bytes)}`;
  }

  async function uploadPhotos(event) {
    event.preventDefault();
    const files = Array.from($('photoInput').files || []);
    if (!files.length) {
      showToast('画像を選択してください。', true);
      return;
    }
    if (!state.pin) {
      showToast('PIN認証後にアップロードしてください。', true);
      return;
    }
    const form = new FormData();
    for (const file of files) form.append('photos', file, file.name);
    setProgress(0, true);
    setBusy(event.submitter, true);
    try {
      const result = await xhrUpload(`/api/albums/${encodeURIComponent(state.albumId)}/upload`, form, state.pin, (percent) => setProgress(percent, true));
      state.album = result.album;
      renderAlbum();
      $('photoInput').value = '';
      updateSelectedText();
      showToast(`${result.uploadedCount}枚アップロードしました。`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setProgress(0, false);
      setBusy(event.submitter, false);
    }
  }

  async function downloadZip() {
    if (!state.album || state.album.fileCount === 0) {
      showToast('保存する画像がありません。', true);
      return;
    }
    setBusy($('downloadButton'), true);
    try {
      const result = await api(`/api/albums/${encodeURIComponent(state.albumId)}/download-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Album-Pin': state.pin
        },
        body: JSON.stringify({})
      });
      location.href = result.downloadUrl;
      showToast('ZIP保存を開始しました。');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy($('downloadButton'), false);
    }
  }

  async function deleteAlbum() {
    if (!confirm('アップロード済み画像をサーバー側から削除します。PCに保存済みであることを確認してください。')) return;
    setBusy($('deleteButton'), true);
    try {
      await api(`/api/albums/${encodeURIComponent(state.albumId)}/delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Album-Pin': state.pin
        },
        body: JSON.stringify({})
      });
      sessionStorage.removeItem(pinKey(state.albumId));
      alert('アルバムを削除しました。');
      location.href = '/';
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setBusy($('deleteButton'), false);
    }
  }

  async function copyAlbumUrl() {
    try {
      await navigator.clipboard.writeText($('albumUrl').value);
      showToast('URLをコピーしました。');
    } catch (_) {
      $('albumUrl').select();
      showToast('URL欄を選択しました。コピーしてください。');
    }
  }

  async function api(url, options = {}) {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : { ok: res.ok, error: await res.text() };
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function xhrUpload(url, formData, pin, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Album-Pin', pin);
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) resolve(data);
          else reject(new Error(data.error || `HTTP ${xhr.status}`));
        } catch (err) {
          reject(err);
        }
      });
      xhr.addEventListener('error', () => reject(new Error('アップロード通信に失敗しました。')));
      xhr.send(formData);
    });
  }

  function startAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (state.albumId && state.pin && !document.hidden) loadAlbum(true);
    }, 8000);
  }

  function startCountdown() {
    if (state.timer) clearInterval(state.timer);
    updateCountdown();
    state.timer = setInterval(updateCountdown, 1000);
  }

  function updateCountdown() {
    if (!state.album) return;
    const remaining = Math.max(0, Number(state.album.expiresAt) - Date.now());
    const totalSeconds = Math.floor(remaining / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    $('countdown').textContent = `残り ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDate(value) {
    return new Date(value).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  }

  function setBusy(button, busy) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = '処理中...';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function setProgress(percent, visible) {
    $('progressOuter').classList.toggle('hidden', !visible);
    $('progressInner').style.width = `${percent}%`;
  }

  function showToast(message, isError = false) {
    const toast = $('toast');
    toast.textContent = message;
    toast.style.background = isError ? '#991b1b' : '#0f172a';
    toast.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.add('hidden'), 3600);
  }
})();
