/* RT-Viewer Local Script (Final Complete Version) */

const state = {
    caseId: null,
    manifest: null,
    ctVolume: null,
    isLocalMode: false, // ローカルモードかどうかのフラグ
    doseUnit: 'Gy',     // 現在の単位 'Gy' or '%'
    maxDose: 60.0,      // 現在のプランの最大線量 (Gy)
    
    viewports: {
        left: { el: document.getElementById('dicomLeft'), doseCanvas: document.getElementById('doseCanvasLeft'), structCanvas: document.getElementById('structCanvasLeft'), doseId: "", structId: "", structData: null, doseVolume: null, doseMeta: null, roiVisibility: {}, roiListEl: document.getElementById('roiListLeft') },
        right: { el: document.getElementById('dicomRight'), doseCanvas: document.getElementById('doseCanvasRight'), structCanvas: document.getElementById('structCanvasRight'), doseId: "", structId: "", structData: null, doseVolume: null, doseMeta: null, roiVisibility: {}, roiListEl: document.getElementById('roiListRight') }
    }
};

const ui = {
    caseSel: document.getElementById('caseSelector'),
    slider: document.getElementById('sliceSlider'),
    sliceInfo: document.getElementById('sliceInfo'),
    doseMin: document.getElementById('doseMin'),
    doseMax: document.getElementById('doseMax'),
    dispMin: document.getElementById('dispMin'),
    dispMax: document.getElementById('dispMax'),
    opacity: document.getElementById('doseOpacity'),
    loadingBar: document.getElementById('loadingBar'),
    loadingContainer: document.getElementById('loadingBarContainer'),
    
    // 線量単位・正規化
    unitGy: document.getElementById('unitGy'),
    unitPct: document.getElementById('unitPct'),
    normDose: document.getElementById('normDose'),

    left: { structSel: document.getElementById('selStructLeft'), doseSel: document.getElementById('selDoseLeft') },
    right: { structSel: document.getElementById('selStructRight'), doseSel: document.getElementById('selDoseRight') }
};

function init() {
    // Cornerstone初期化
    cornerstoneTools.external.cornerstone = cornerstone;
    cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
    cornerstoneTools.external.Hammer = Hammer;
    cornerstoneTools.init();
    
    // ビューポート設定
    ['left', 'right'].forEach(k => {
        const el = state.viewports[k].el;
        cornerstone.enable(el);
        
        const tools = [cornerstoneTools.WwwcTool, cornerstoneTools.PanTool, cornerstoneTools.ZoomTool];
        tools.forEach(t => cornerstoneTools.addTool(t));
        
        cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
        cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 2 });
        cornerstoneTools.setToolActive('Pan', { mouseButtonMask: 4 });

        el.addEventListener('cornerstoneimagerendered', () => redrawOverlay(k));
        
        // ホイールスクロール
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!state.ctVolume) return;
            const dir = e.deltaY > 0 ? 1 : -1;
            let val = parseInt(ui.slider.value) + dir;
            val = Math.max(0, Math.min(val, parseInt(ui.slider.max)));
            if(val !== parseInt(ui.slider.value)) {
                ui.slider.value = val;
                drawSlice(val);
            }
        });
    });

    // 同期設定
    const syncPZ = new cornerstoneTools.Synchronizer("cornerstoneimagerendered", cornerstoneTools.panZoomSynchronizer);
    const syncWC = new cornerstoneTools.Synchronizer("cornerstoneimagerendered", cornerstoneTools.wwwcSynchronizer);
    ['left', 'right'].forEach(k => {
        syncPZ.add(state.viewports[k].el);
        syncWC.add(state.viewports[k].el);
    });

    // UIイベントリスナー
    ui.slider.addEventListener('input', (e) => drawSlice(parseInt(e.target.value)));
    
    // 線量調整スライダー
    ui.doseMin.addEventListener('input', updateVisuals);
    ui.doseMax.addEventListener('input', updateVisuals);
    ui.opacity.addEventListener('input', updateVisuals);

    // ★ Gy / % 切り替えイベント
    ui.unitGy.addEventListener('change', () => { setDoseUnit('Gy'); });
    ui.unitPct.addEventListener('change', () => { setDoseUnit('%'); });
    ui.normDose.addEventListener('input', updateVisuals);

    // ケース選択
    ui.caseSel.addEventListener('change', (e) => {
        if(state.isLocalMode) {
            loadLocalCaseData(e.target.value);
        } else {
            // Web版のロジックが必要ならここに書く（今回はローカル専用なので省略可）
            alert("Web Mode is not implemented in this local version.");
        }
    });

    // Dose/Struct選択
    ['left', 'right'].forEach(k => {
        ui[k].doseSel.addEventListener('change', (e) => loadDose(k, e.target.value));
        ui[k].structSel.addEventListener('change', (e) => loadStruct(k, e.target.value));
    });
}

// ========================================================
//  Python (pywebview) 連携部分
// ========================================================

function openLocalFolder() {
    if (window.pywebview) {
        window.pywebview.api.select_folder();
    } else {
        alert("Desktop App mode required.");
    }
}

// Pythonから呼ばれる: 症例リストのロード完了
function onCasesLoaded(caseList) {
    hideLoading();
    state.isLocalMode = true;

    ui.caseSel.innerHTML = "";
    caseList.forEach(id => {
        let o = document.createElement('option');
        o.value = id;
        o.text = id;
        ui.caseSel.add(o);
    });

    // 先頭の症例を自動ロード
    if(caseList.length > 0) {
        loadLocalCaseData(caseList[0]);
    }
}

// ========================================================
//  データ読み込みロジック
// ========================================================

async function loadLocalCaseData(caseId) {
    // 読み込み開始時はバーをリセットしない（Python側で制御済みのこともあるが念のため）
    // showLoading("Loading Case..."); 

    state.caseId = caseId;
    state.currentBasePath = `./temp_data/${caseId}`;
    
    try {
        // マニフェスト取得
        const mf = await fetch(`${state.currentBasePath}/manifest.json`).then(r=>r.json());
        state.manifest = mf;
        
        // CTデータ (Int16 Raw) 取得
        const buf = await fetch(`${state.currentBasePath}/ct.bin`).then(r=>r.arrayBuffer());
        state.ctVolume = new Int16Array(buf);
        
        // スライダー設定
        ui.slider.max = mf.ct.count - 1;
        ui.slider.value = Math.floor(mf.ct.count / 2);
        
        // メニューリセット
        const doseKeys = Object.keys(mf.doses);
        const structKeys = Object.keys(mf.structs);
        
        ['left', 'right'].forEach(k => {
            ui[k].doseSel.innerHTML = "<option value=''>None</option>";
            doseKeys.forEach(d => { let o=document.createElement('option'); o.value=d; o.text=d; ui[k].doseSel.add(o); });
            ui[k].structSel.innerHTML = "<option value=''>None</option>";
            structKeys.forEach(s => { let o=document.createElement('option'); o.value=s; o.text=s; ui[k].structSel.add(o); });
        });

        // データロード
        if(doseKeys.length > 0) await loadDose('left', doseKeys[0]);
        if(doseKeys.length > 1) await loadDose('right', doseKeys[1]); else if(doseKeys.length > 0) await loadDose('right', doseKeys[0]);
        if(structKeys.length > 0) { await loadStruct('left', structKeys[0]); await loadStruct('right', structKeys[0]); }
        
        // リサイズ & 描画
        ['left', 'right'].forEach(k => cornerstone.resize(state.viewports[k].el));
        drawSlice(parseInt(ui.slider.value));

    } catch(e) {
        console.error(e);
        alert("Failed to load case data.");
    }
    
    // ロード完了時にバーを消す
    hideLoading();
}

async function loadDose(key, doseId) {
    const vp = state.viewports[key];
    vp.doseId = doseId;
    ui[key].doseSel.value = doseId;

    if(!doseId) {
        vp.doseVolume = null;
        vp.doseMeta = null;
        redrawOverlay(key);
        return;
    }
    
    const meta = state.manifest.doses[doseId];
    vp.doseMeta = meta;

    // ★ 最大線量の記録（Gyスライダーの上限計算用）
    state.maxDose = meta.max_dose;
    
    // ★ 処方線量があれば、それを100%基準の初期値にする
    if(meta.prescription && meta.prescription > 0) {
        ui.normDose.value = meta.prescription;
    }

    // データ読み込み
    const basePath = state.currentBasePath || `./static/data/${state.caseId}`;
    const buf = await fetch(`${basePath}/${meta.filename}`).then(r=>r.arrayBuffer());
    vp.doseVolume = new Float32Array(buf);
    
    // ★ 読み込み後にスライダーのメモリを更新
    updateSliderScale();

    redrawOverlay(key);
}

async function loadStruct(key, structId) {
    const vp = state.viewports[key];
    vp.structId = structId;
    ui[key].structSel.value = structId;

    if(!structId) {
        vp.structData = null;
        redrawOverlay(key);
        return;
    }
    
    const fn = state.manifest.structs[structId];
    const basePath = state.currentBasePath || `./static/data/${state.caseId}`;
    vp.structData = await fetch(`${basePath}/${fn}`).then(r=>r.json());
    
    // ROIリスト作成
    vp.roiListEl.innerHTML = "";
    
    // ALL ON/OFF ボタン
    const btnRow = document.createElement('div');
    btnRow.style.padding = "5px"; btnRow.style.borderBottom = "1px solid #333"; btnRow.style.marginBottom = "5px";
    const btn = document.createElement('button');
    btn.className = "btn-tiny full-width";
    btn.textContent = "👁️ ALL ON/OFF";
    btn.onclick = () => window.toggleAllROI(key);
    btnRow.appendChild(btn);
    vp.roiListEl.appendChild(btnRow);

    // 個別チェックボックス
    Object.keys(vp.structData).forEach(n => {
        if(vp.roiVisibility[n] === undefined) vp.roiVisibility[n] = true;
        
        const d = document.createElement('div');
        d.className = 'roi-item';
        
        const chk = document.createElement('input');
        chk.type='checkbox';
        chk.checked = vp.roiVisibility[n];
        chk.onchange = () => {
            vp.roiVisibility[n] = chk.checked;
            redrawOverlay(key);
        };
        
        const box = document.createElement('div');
        box.className='roi-color-box';
        box.style.background = vp.structData[n].color;
        
        const name = document.createElement('span');
        name.className='roi-name';
        name.textContent = n;
        
        d.append(chk, box, name);
        vp.roiListEl.appendChild(d);
    });
    
    redrawOverlay(key);
}

// ========================================================
//  単位変換・スライダー制御 (Gy vs %)
// ========================================================

function setDoseUnit(unit) {
    if (state.doseUnit === unit) return;

    const norm = parseFloat(ui.normDose.value) || 60.0;
    const currentMin = parseFloat(ui.doseMin.value);
    const currentMax = parseFloat(ui.doseMax.value);

    state.doseUnit = unit;

    if (unit === '%') {
        // Gy -> %
        ui.doseMin.max = 120;
        ui.doseMax.max = 120;
        ui.doseMin.step = 1;
        ui.doseMax.step = 1;

        ui.doseMin.value = ((currentMin / norm) * 100).toFixed(0);
        ui.doseMax.value = ((currentMax / norm) * 100).toFixed(0);
    } else {
        // % -> Gy
        const maxD = state.maxDose || norm;
        ui.doseMin.max = (maxD * 1.1).toFixed(1);
        ui.doseMax.max = (maxD * 1.1).toFixed(1);
        ui.doseMin.step = 0.1;
        ui.doseMax.step = 0.1;

        ui.doseMin.value = ((currentMin / 100) * norm).toFixed(1);
        ui.doseMax.value = ((currentMax / 100) * norm).toFixed(1);
    }
    updateVisuals();
}

function updateSliderScale() {
    // 現在のモードに合わせてスライダーの最大値を再設定
    if(state.doseUnit === '%') {
        ui.doseMin.max = 120;
        ui.doseMax.max = 120;
    } else {
        const maxD = state.maxDose || 60.0;
        // Gyなら最大線量+10%くらいまでスライドできるようにする
        ui.doseMin.max = (maxD * 1.1).toFixed(1);
        ui.doseMax.max = (maxD * 1.1).toFixed(1);
    }
}

// ========================================================
//  描画・更新ロジック
// ========================================================

function drawSlice(idx) {
    if (!state.ctVolume) return;
    const meta = state.manifest.ct;
    const start = idx * meta.rows * meta.cols;
    const px = state.ctVolume.subarray(start, start + meta.rows * meta.cols);
    
    ['left', 'right'].forEach(k => {
        const el = state.viewports[k].el;
        const img = {
            imageId: `ct:${state.caseId}:${idx}:${k}`,
            minPixelValue: -1024,
            maxPixelValue: 3000,
            rows: meta.rows,
            columns: meta.cols,
            height: meta.rows,
            width: meta.cols,
            getPixelData: () => px,
            sizeInBytes: px.byteLength,
            color: false,
            columnPixelSpacing: meta.spacing[0],
            rowPixelSpacing: meta.spacing[1],
            slope: 1.0,
            intercept: 0.0,
            windowCenter: 40,
            windowWidth: 400,
            render: cornerstone.renderGrayscaleImage,
            get: () => undefined
        };
        
        // 現在のWW/WLを維持
        try {
            const vp = cornerstone.getViewport(el);
            if(vp) {
                img.windowCenter = vp.voi.windowCenter;
                img.windowWidth = vp.voi.windowWidth;
            }
        } catch(e){}
        
        cornerstone.displayImage(el, img);
        redrawOverlay(k);
    });
    
    ui.sliceInfo.textContent = `${idx} / ${meta.count-1}`;
}

function redrawOverlay(key) {
    const vp = state.viewports[key];
    const el = vp.el;
    const enEl = cornerstone.getEnabledElement(el);
    if (!enEl || !enEl.image) return;
    
    const w = el.clientWidth;
    const h = el.clientHeight;
    
    if (vp.doseCanvas.width !== w) { vp.doseCanvas.width = w; vp.doseCanvas.height = h; }
    if (vp.structCanvas.width !== w) { vp.structCanvas.width = w; vp.structCanvas.height = h; }
    
    const dCtx = vp.doseCanvas.getContext('2d');
    const sCtx = vp.structCanvas.getContext('2d');
    dCtx.clearRect(0,0,w,h);
    sCtx.clearRect(0,0,w,h);
    
    // --- 線量描画 ---
    if (vp.doseVolume) {
        const ctZ = state.manifest.ct.z_positions[parseInt(ui.slider.value)];
        let bestZ = -1, minD = 999;
        
        const doseZPositions = vp.doseMeta.z_positions || [];
        doseZPositions.forEach((dz, i) => {
            const diff = Math.abs(dz - ctZ);
            if(diff < minD) { minD = diff; bestZ = i; }
        });
        
        // Z座標が近ければ描画 (許容誤差2mm)
        if (minD < 2.0 && bestZ !== -1) {
            const dMeta = vp.doseMeta;
            const start = bestZ * dMeta.rows * dMeta.cols;
            const doseSlice = vp.doseVolume.subarray(start, start + dMeta.rows * dMeta.cols);
            
            const c = document.createElement('canvas');
            c.width = dMeta.cols;
            c.height = dMeta.rows;
            const cx = c.getContext('2d');
            const imgData = cx.createImageData(dMeta.cols, dMeta.rows);
            
            // 閾値計算
            let minV, maxV;
            const norm = parseFloat(ui.normDose.value) || 60;
            
            if(state.doseUnit === 'Gy') {
                minV = parseFloat(ui.doseMin.value);
                maxV = parseFloat(ui.doseMax.value);
            } else {
                minV = (parseFloat(ui.doseMin.value)/100) * norm;
                maxV = (parseFloat(ui.doseMax.value)/100) * norm;
            }
            
            for(let i=0; i<doseSlice.length; i++) {
                const v = doseSlice[i];
                if(v >= minV) {
                    const color = getDoseColor(v, maxV);
                    const p = i*4;
                    imgData.data[p] = color[0];
                    imgData.data[p+1] = color[1];
                    imgData.data[p+2] = color[2];
                    imgData.data[p+3] = 200; // Alpha
                }
            }
            cx.putImageData(imgData, 0, 0);
            
            dCtx.save();
            dCtx.globalAlpha = ui.opacity.value;
            dCtx.imageSmoothingEnabled = true; // 滑らかに拡大
            cornerstone.setToPixelCoordinateSystem(enEl, dCtx);
            
            const ctMeta = state.manifest.ct;
            // 座標合わせ (Origin + Spacing)
            const dx = (dMeta.origin[0] - ctMeta.origin[0]) / ctMeta.spacing[0];
            const dy = (dMeta.origin[1] - ctMeta.origin[1]) / ctMeta.spacing[1];
            const dw = dMeta.cols * (dMeta.spacing[0] / ctMeta.spacing[0]);
            const dh = dMeta.rows * (dMeta.spacing[1] / ctMeta.spacing[1]);
            
            dCtx.drawImage(c, dx, dy, dw, dh);
            dCtx.restore();
        }
    }
    
    // --- 構造セット描画 ---
    if (vp.structData) {
        sCtx.save();
        cornerstone.setToPixelCoordinateSystem(enEl, sCtx);
        sCtx.lineWidth = 2.0 / enEl.viewport.scale; // ズームしても線の太さ維持
        
        const ctZ = state.manifest.ct.z_positions[parseInt(ui.slider.value)];
        
        Object.keys(vp.structData).forEach(roi => {
            if (vp.roiVisibility[roi] === false) return;
            
            const s = vp.structData[roi];
            let pts = s.contours[ctZ.toFixed(2)]; // 完全一致検索
            
            // なければ近似検索 (誤差0.1mm)
            if (!pts) {
                const keys = Object.keys(s.contours);
                for(let k of keys) {
                    if(Math.abs(parseFloat(k)-ctZ) < 0.1) {
                        pts = s.contours[k];
                        break;
                    }
                }
            }
            
            if (pts) {
                sCtx.strokeStyle = s.color;
                sCtx.beginPath();
                pts.forEach(poly => {
                    sCtx.moveTo(poly[0][0], poly[0][1]);
                    for(let i=1; i<poly.length; i++) sCtx.lineTo(poly[i][0], poly[i][1]);
                    sCtx.closePath();
                });
                sCtx.stroke();
            }
        });
        sCtx.restore();
    }
}

function updateVisuals() {
    ui.dispMin.textContent = ui.doseMin.value;
    ui.dispMax.textContent = ui.doseMax.value;
    ['left', 'right'].forEach(k => redrawOverlay(k));
}

function getDoseColor(v, max) {
    const r = v/max;
    // Cold(Blue) -> Hot(Red)
    if(r<0.25) return [0, r*4*255, 255];
    if(r<0.5) return [0, 255, (1-(r-0.25)*4)*255];
    if(r<0.75) return [(r-0.5)*4*255, 255, 0];
    return [255, (1-(r-0.75)*4)*255, 0];
}

// 外部から呼べるヘルパー
window.toggleAllROI = (key) => {
    const vp = state.viewports[key];
    if(!vp.structData) return;
    
    const allKeys = Object.keys(vp.structData);
    const targetState = allKeys.some(k => vp.roiVisibility[k] === false);
    
    allKeys.forEach(k => vp.roiVisibility[k] = targetState);
    
    const checkboxes = vp.roiListEl.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = targetState);
    
    redrawOverlay(key);
};

window.setWL = (ww, wc) => {
    ['left', 'right'].forEach(k => {
        const vp = cornerstone.getViewport(state.viewports[k].el);
        if(vp) {
            vp.voi.windowWidth = ww;
            vp.voi.windowCenter = wc;
            cornerstone.setViewport(state.viewports[k].el, vp);
        }
    });
};

// ========================================================
//  プログレスバー制御 (Python連携用)
// ========================================================

function showLoading(msg) {
    const bar = ui.loadingBar;
    const container = ui.loadingContainer;
    if(bar) {
        bar.style.width = "0%";
        bar.style.transition = "width 0.2s";
        bar.style.background = "#FFC107"; // 黄色 (処理中)
        bar.style.display = "block";
        if(container) container.style.display = "block";
    }
    console.log(msg);
}

function updateProgress(percent) {
    const bar = ui.loadingBar;
    if(bar) {
        // Pythonからの通知でバーを伸ばす
        // 100%になりきらないようにキャップする (描画完了待ち)
        const visualPercent = Math.min(Math.max(0, percent), 95);
        bar.style.width = visualPercent + "%";
    }
}

function hideLoading() {
    const bar = ui.loadingBar;
    if(bar) {
        bar.style.width = "100%";
        bar.style.background = "#4CAF50"; // 緑 (完了)
        setTimeout(() => {
            bar.style.width = "0%";
        }, 500);
    }
}

// 開始
init();