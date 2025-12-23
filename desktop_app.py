import os
import shutil
import json
import re
import threading
import time
import webview
from flask import Flask, send_from_directory
import pydicom
import numpy as np

# --- 設定 ---
# 一時データ保存場所
TEMP_DIR = os.path.join(os.getcwd(), "temp_data")

# Flaskサーバー設定
server = Flask(__name__, static_folder='static')

@server.route('/')
def index():
    return send_from_directory('.', 'index.html')

@server.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

@server.route('/temp_data/<path:path>')
def serve_temp(path):
    return send_from_directory(TEMP_DIR, path)

def start_server():
    server.run(port=5555, threaded=True)

# ==========================================
#  進捗報告付き 変換ロジック
# ==========================================

def report_progress(window, current_count, total_files):
    if total_files == 0: return
    pct = int((current_count / total_files) * 100)
    if pct > 95: pct = 95
    try:
        window.evaluate_js(f'updateProgress({pct})')
    except:
        pass

def process_single_case(window, case_dir, case_id, current_count, total_files):
    out_dir = os.path.join(TEMP_DIR, case_id)
    os.makedirs(out_dir, exist_ok=True)

    ct_files = []
    dose_files = []
    struct_files = []

    try:
        files_in_dir = [f for f in os.listdir(case_dir) if not os.path.isdir(os.path.join(case_dir, f))]
    except:
        return False

    for i, f in enumerate(files_in_dir):
        fp = os.path.join(case_dir, f)
        current_count[0] += 1
        
        # 10ファイルに1回報告 & 少し休憩 (Surface Go対策)
        if current_count[0] % 10 == 0:
            report_progress(window, current_count[0], total_files)
            time.sleep(0.001)

        try:
            ds = pydicom.dcmread(fp, stop_before_pixels=True)
            if ds.Modality == 'CT':
                ct_files.append((float(ds.ImagePositionPatient[2]), fp))
            elif ds.Modality == 'RTDOSE':
                dose_files.append(fp)
            elif ds.Modality == 'RTSTRUCT':
                struct_files.append(fp)
        except:
            pass

    if not ct_files: return False

    # CT処理
    ct_files.sort(key=lambda x: x[0], reverse=True)
    
    ds0 = pydicom.dcmread(ct_files[0][1])
    rows, cols = ds0.Rows, ds0.Columns
    spacing = [float(ds0.PixelSpacing[1]), float(ds0.PixelSpacing[0])]
    origin = [float(x) for x in ds0.ImagePositionPatient]
    slope = float(getattr(ds0, 'RescaleSlope', 1))
    intercept = float(getattr(ds0, 'RescaleIntercept', 0))
    z_positions = [x[0] for x in ct_files]

    ct_bin_path = os.path.join(out_dir, 'ct.bin')
    with open(ct_bin_path, 'wb') as f:
        for i, (z, fp) in enumerate(ct_files):
            try:
                ds = pydicom.dcmread(fp)
                px = ds.pixel_array.astype(np.float32) * slope + intercept
                f.write(px.astype(np.int16).tobytes())
            except:
                f.write(np.zeros((rows, cols), dtype=np.int16).tobytes())
            
            # 書き込み中もたまに休憩
            if i % 20 == 0: time.sleep(0.001)

    cm = { "type": "CT", "rows": rows, "cols": cols, "spacing": spacing, "origin": origin,
           "z_positions": z_positions, "count": len(ct_files), "dataType": "int16", "chunks": 1 }

    # Dose処理
    dm = {}
    for fp in dose_files:
        try:
            ds = pydicom.dcmread(fp)
            fn = os.path.basename(fp).replace('.dcm', '.bin')
            sc = float(getattr(ds, 'DoseGridScaling', 1.0))
            vol = (ds.pixel_array * sc).astype(np.float32)
            with open(os.path.join(out_dir, fn), 'wb') as f: f.write(vol.tobytes())
            
            do = [float(x) for x in ds.ImagePositionPatient]
            dsp = [float(x) for x in ds.PixelSpacing]
            doff = np.array(ds.GridFrameOffsetVector) if hasattr(ds,'GridFrameOffsetVector') else np.array([0.0])
            dzs = (do[2] + doff).tolist()
            meta = { "filename": fn, "rows": ds.Rows, "cols": ds.Columns, "origin": do, "spacing": [dsp[1], dsp[0]],
                     "max_dose": float(np.max(vol)), "z_positions": dzs, "chunks": 1 }
            try: meta["prescription"] = float(re.sub(r"[^0-9.]","",os.path.splitext(fn)[0].split('_')[-1]))
            except: meta["prescription"] = meta["max_dose"]
            dm[os.path.splitext(fn)[0]] = meta
        except: pass

    # Struct処理
    sm = {}
    for fp in struct_files:
        try:
            ds = pydicom.dcmread(fp)
            s_dict = {}; rois = {}
            if hasattr(ds,'StructureSetROISequence'):
                for r in ds.StructureSetROISequence: rois[r.ROINumber]={'name':r.ROIName,'color':'#00FFFF'}
            if hasattr(ds,'ROIContourSequence'):
                for rc in ds.ROIContourSequence:
                    rn = rc.ReferencedROINumber
                    if rn not in rois: continue
                    if hasattr(rc,'ROIDisplayColor'): c=rc.ROIDisplayColor; rois[rn]['color']=f"#{int(c[0]):02x}{int(c[1]):02x}{int(c[2]):02x}"
                    cd = {}
                    if hasattr(rc,'ContourSequence'):
                        for c in rc.ContourSequence:
                            pts = np.array(c.ContourData).reshape(-1,3)
                            pix = (pts[:,:2] - origin[:2]) / spacing
                            z = pts[0,2]; zk = f"{z:.2f}"
                            if zk not in cd: cd[zk] = []
                            cd[zk].append(pix.tolist())
                    if cd: s_dict[rois[rn]['name']] = {'color':rois[rn]['color'], 'contours':cd}
            if s_dict:
                sn = os.path.splitext(os.path.basename(fp))[0]
                json.dump(s_dict, open(os.path.join(out_dir, f"{sn}.json"), 'w'))
                sm[sn] = f"{sn}.json"
        except: pass

    mf = {"id": case_id, "ct": cm, "doses": dm, "structs": sm}
    json.dump(mf, open(os.path.join(out_dir, 'manifest.json'), 'w'))
    return True

def conv_logic_multi(window, root_dir):
    # 開始時もお掃除
    if os.path.exists(TEMP_DIR): shutil.rmtree(TEMP_DIR)
    os.makedirs(TEMP_DIR, exist_ok=True)
    
    found_cases = []
    window.evaluate_js('showLoading("Scanning files...")')
    
    total_files = 0
    for root, dirs, files in os.walk(root_dir):
        total_files += len([f for f in files if f.endswith('.dcm') or f.endswith('.DCM')])
    
    if total_files == 0: return None

    current_count = [0] 

    root_has_ct = False
    for f in os.listdir(root_dir):
        if f.endswith('.dcm') or f.endswith('.DCM'):
            root_has_ct = True; break
    
    if root_has_ct:
        cid = os.path.basename(root_dir)
        if not cid: cid = "Patient_Root"
        if process_single_case(window, root_dir, cid, current_count, total_files):
            found_cases.append(cid)
    
    for current_root, dirs, files in os.walk(root_dir):
        if current_root == root_dir and root_has_ct: continue
        has_dcm = any(f.endswith('.dcm') or f.endswith('.DCM') for f in files)
        if has_dcm:
            cid = os.path.basename(current_root)
            base_cid = cid; count = 2
            while cid in found_cases: cid = f"{base_cid}_{count}"; count += 1
            if process_single_case(window, current_root, cid, current_count, total_files):
                found_cases.append(cid)

    if found_cases:
        json.dump(found_cases, open(os.path.join(TEMP_DIR, 'cases.json'), 'w'))
        report_progress(window, total_files, total_files)
        return found_cases
    return None

class Api:
    def select_folder(self):
        w = webview.windows[0]
        f = w.create_file_dialog(webview.FOLDER_DIALOG)
        if f and len(f) > 0:
            target_path = f[0]
            def run_thread():
                try:
                    cases = conv_logic_multi(w, target_path)
                    if cases:
                        w.evaluate_js(f'onCasesLoaded({json.dumps(cases)})')
                    else:
                        w.evaluate_js('alert("No DICOM found")')
                        w.evaluate_js('hideLoading()')
                except Exception as e:
                    print(e)
                    w.evaluate_js('hideLoading()')
            threading.Thread(target=run_thread).start()

if __name__ == '__main__':
    t = threading.Thread(target=start_server, daemon=True)
    t.start()
    
    api = Api()
    webview.create_window('RT-Viewer Local', 'http://localhost:5555', js_api=api, width=1280, height=800)
    
    # アプリ開始（ウィンドウが閉じられるまでここで待機）
    webview.start()
    
    # ★ここに追加: アプリ終了後のお掃除
    # ウィンドウが閉じたらここに来る
    print("Cleaning up temp files...")
    if os.path.exists(TEMP_DIR):
        try:
            shutil.rmtree(TEMP_DIR)
        except Exception as e:
            print(f"Cleanup failed: {e}")