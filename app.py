import os
import json
import math
import secrets
import threading
from datetime import datetime
from functools import wraps
from io import BytesIO
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory, session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static'),
    static_url_path='/static'
)
app.secret_key = os.environ.get('AYO_LOMBA_SECRET') or 'ayo-lomba-default-secret-key-2026'
app.config.update(
    SESSION_COOKIE_NAME='ayo_lomba_session',
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=False
)
READONLY_DB_PATH = os.path.join(BASE_DIR, 'data', 'db.json')
DATABASE_URL = os.environ.get('DATABASE_URL') or os.environ.get('POSTGRES_URL')

# Di Vercel Serverless tanpa DB online, folder /tmp yang dipakai
if os.environ.get('VERCEL') and not DATABASE_URL:
    DB_PATH = '/tmp/db.json'
else:
    DB_PATH = READONLY_DB_PATH

DB_LOCK = threading.Lock()

# Unambiguous characters for participant PIN/password
SAFE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def get_pg_connection():
    if not DATABASE_URL:
        return None
    try:
        import psycopg2
        # Clean sslmode from URL if present to avoid driver overwrite
        clean_url = DATABASE_URL.replace("?sslmode=require", "").replace("&sslmode=require", "")
        return psycopg2.connect(clean_url, sslmode='require')
    except Exception as e:
        print(f"PostgreSQL connection error: {e}")
        return None


def init_pg_db():
    conn = get_pg_connection()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS app_state (
                    id VARCHAR(50) PRIMARY KEY,
                    data JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            # Check if seed state exists
            cur.execute("SELECT data FROM app_state WHERE id = 'ayo_lomba_main';")
            row = cur.fetchone()
            if not row and os.path.exists(READONLY_DB_PATH):
                with open(READONLY_DB_PATH, 'r', encoding='utf-8') as f:
                    seed_data = json.load(f)
                cur.execute(
                    "INSERT INTO app_state (id, data) VALUES ('ayo_lomba_main', %s);",
                    (json.dumps(seed_data),)
                )
        conn.commit()
    except Exception as e:
        print(f"Init PG error: {e}")
    finally:
        conn.close()


# Try initializing PG if DATABASE_URL is configured
if DATABASE_URL:
    init_pg_db()


def load_data():
    with DB_LOCK:
        # 1. Coba baca dari PostgreSQL (Supabase) jika tersedia
        conn = get_pg_connection()
        if conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT data FROM app_state WHERE id = 'ayo_lomba_main';")
                    row = cur.fetchone()
                    if row:
                        val = row[0]
                        return val if isinstance(val, dict) else json.loads(val)
            except Exception as e:
                print(f"PG Read Error: {e}")
            finally:
                conn.close()

        # 2. Fallback baca dari JSON file lokal / tmp
        if not os.path.exists(DB_PATH):
            if os.path.exists(READONLY_DB_PATH):
                try:
                    with open(READONLY_DB_PATH, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    if os.environ.get('VERCEL'):
                        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
                        with open(DB_PATH, 'w', encoding='utf-8') as f:
                            json.dump(data, f, indent=2, ensure_ascii=False)
                    return data
                except Exception:
                    pass
            return {"events": [], "participants": [], "panitia": []}
        try:
            with open(DB_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {"events": [], "participants": [], "panitia": []}


def save_data(data):
    with DB_LOCK:
        # 1. Simpan ke PostgreSQL (Supabase) jika tersedia
        conn = get_pg_connection()
        if conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO app_state (id, data, updated_at)
                        VALUES ('ayo_lomba_main', %s, CURRENT_TIMESTAMP)
                        ON CONFLICT (id) DO UPDATE SET
                            data = EXCLUDED.data,
                            updated_at = CURRENT_TIMESTAMP;
                    """, (json.dumps(data),))
                conn.commit()
                return
            except Exception as e:
                print(f"PG Save Error: {e}")
            finally:
                conn.close()

        # 2. Fallback simpan ke JSON file
        try:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            with open(DB_PATH, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"File Save Error: {e}")


def normalize_text(val):
    return ' '.join((val or '').strip().lower().split())


def is_schedule_locked(event):
    deadline_str = (event.get('registrationDeadline') or '').strip()
    if not deadline_str:
        return False
    try:
        # Support YYYY-MM-DDTHH:MM or YYYY-MM-DD
        fmt = '%Y-%m-%dT%H:%M' if 'T' in deadline_str else '%Y-%m-%d'
        deadline_dt = datetime.strptime(deadline_str, fmt)
        return datetime.now() >= deadline_dt
    except ValueError:
        return False


def enrich_event_status(event, participants):
    ev_copy = json.loads(json.dumps(event))
    sched_locked = is_schedule_locked(ev_copy)
    ev_copy['scheduleLocked'] = sched_locked
    ev_copy['effectiveLocked'] = bool(ev_copy.get('locked', False)) or sched_locked
    ev_copy['participantCount'] = sum(
        1 for p in participants if p.get('eventId') == ev_copy.get('id')
    )
    for comp in ev_copy.get('competitions', []):
        comp['effectiveLocked'] = ev_copy['effectiveLocked'] or bool(comp.get('locked', False))
        comp['participantCount'] = sum(
            1 for p in participants if p.get('competitionId') == comp.get('id')
        )
    return ev_copy


def generate_participant_credentials(event_id, existing_ids):
    prefix_map = {
        'bulan-bahasa': 'AYO-BB',
        'porak': 'AYO-PRK',
        '17-agustus': 'AYO-AGT',
    }
    pfx = prefix_map.get(event_id, 'AYO-LMB')
    for _ in range(50):
        num = 1000 + secrets.randbelow(9000)
        user_id = f"{pfx}-{num}"
        if user_id not in existing_ids:
            password = ''.join(secrets.choice(SAFE_CHARS) for _ in range(6))
            return user_id, password
    # Fallback longer suffix
    user_id = f"{pfx}-{secrets.token_hex(3).upper()}"
    password = ''.join(secrets.choice(SAFE_CHARS) for _ in range(6))
    return user_id, password


def panitia_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get('panitia_id'):
            return jsonify({
                "success": False,
                "message": "Akses ditolak. Silakan login menggunakan ID Unik Panitia terlebih dahulu."
            }), 401
        return fn(*args, **kwargs)
    return wrapper


@app.route('/static/<path:filename>')
def serve_static(filename):
    static_dir = os.path.join(BASE_DIR, 'static')
    return send_from_directory(static_dir, filename)


@app.route('/public/<path:filename>')
def serve_public(filename):
    public_dir = os.path.join(BASE_DIR, 'public')
    return send_from_directory(public_dir, filename)


@app.route('/')
def home():
    return render_template('index.html')


@app.route('/daftar')
def daftar_page():
    return render_template('daftar.html')


@app.route('/peserta')
def peserta_page():
    return render_template('peserta.html')


@app.route('/api/public-data')
def get_public_data():
    data = load_data()
    participants = data.get('participants', [])
    events = [enrich_event_status(ev, participants) for ev in data.get('events', [])]
    return jsonify({
        "events": events,
        "participantCount": len(participants),
        "serverTime": datetime.now().strftime('%Y-%m-%d %H:%M')
    })


@app.route('/api/register', methods=['POST'])
def register():
    payload = request.get_json() or {}
    nama = (payload.get('nama') or '').strip()
    kelas = (payload.get('kelas') or '').strip()
    kontak = (payload.get('kontak') or '').strip()
    event_id = (payload.get('eventId') or '').strip()
    comp_id = (payload.get('competitionId') or '').strip()
    catatan = (payload.get('catatan') or '').strip()
    juknis_viewed = bool(payload.get('juknisViewed'))

    if not juknis_viewed:
        return jsonify({
            "success": False,
            "message": "Anda wajib membuka dan membaca tab Kisi-kisi / Juknis lomba terlebih dahulu sebelum mendaftar."
        }), 400

    if not nama or not kelas or not event_id or not comp_id:
        return jsonify({
            "success": False,
            "message": "Nama Lengkap, Kelas, Event, dan Cabang Lomba wajib diisi."
        }), 400

    data = load_data()
    event = next((e for e in data.get('events', []) if e['id'] == event_id), None)
    if not event:
        return jsonify({"success": False, "message": "Event tidak ditemukan."}), 404

    if event.get('locked', False):
        return jsonify({
            "success": False,
            "message": f"Pendaftaran event {event['name']} sedang ditutup oleh panitia."
        }), 400

    if is_schedule_locked(event):
        return jsonify({
            "success": False,
            "message": f"Pendaftaran event {event['name']} terkunci otomatis karena melewati batas jadwal ({event.get('registrationDeadline', '')})."
        }), 400

    comp = next((c for c in event.get('competitions', []) if c['id'] == comp_id), None)
    if not comp:
        return jsonify({"success": False, "message": "Cabang lomba tidak ditemukan."}), 404

    if comp.get('locked', False):
        return jsonify({
            "success": False,
            "message": f"Cabang lomba {comp['name']} saat ini sedang ditutup oleh panitia."
        }), 400

    # Validasi Lomba Kelompok (Nama Kelompok & Minimal Anggota)
    nama_kelompok = (payload.get('namaKelompok') or '').strip()
    anggota_list = payload.get('anggotaList') or []
    # Bersihkan nama anggota kosong
    anggota_list = [str(a).strip() for a in anggota_list if str(a).strip()]

    is_group = comp.get('isGroup', False) or 'tim' in comp.get('category', '').lower() or 'kelompok' in comp.get('category', '').lower()
    min_members = comp.get('minMembers', 2 if is_group else 1)

    if is_group:
        if not nama_kelompok:
            return jsonify({
                "success": False,
                "message": f"Cabang '{comp['name']}' adalah lomba kelompok. Wajib mengisi Nama Kelompok / Tim!"
            }), 400
        # Total pendaftar dalam kelompok = Ketua/Pendaftar Utama (1) + Anggota
        total_pendaftar = 1 + len(anggota_list)
        if total_pendaftar < min_members:
            return jsonify({
                "success": False,
                "message": f"Cabang '{comp['name']}' membutuhkan minimal {min_members} pendaftar dalam 1 kelompok. Saat ini baru ada {total_pendaftar} orang (Ketua + {len(anggota_list)} anggota)."
            }), 400

    # Single Registration Rule: 1 siswa hanya boleh mendaftar 1 cabang lomba per event
    norm_nama = normalize_text(nama)
    norm_kelas = normalize_text(kelas)
    norm_kontak = normalize_text(kontak)

    for p in data.get('participants', []):
        if p.get('eventId') != event_id:
            continue
        same_student = (
            normalize_text(p.get('nama')) == norm_nama
            and normalize_text(p.get('kelas')) == norm_kelas
        )
        same_phone = bool(norm_kontak and normalize_text(p.get('kontak')) == norm_kontak)
        if same_student or same_phone:
            return jsonify({
                "success": False,
                "message": (
                    f"Pendaftaran ditolak! Siswa '{p.get('nama')}' ({p.get('kelas')}) "
                    f"sudah terdaftar di cabang '{p.get('competitionName')}' pada event {event['name']}. "
                    "Aturan sistem: 1 siswa hanya boleh mendaftar 1 cabang lomba per event."
                )
            }), 400

    existing_ids = {p.get('id') for p in data.get('participants', [])}
    user_id, user_pw = generate_participant_credentials(event_id, existing_ids)
    registered_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    new_participant = {
        "id": user_id,
        "password": user_pw,
        "nama": nama,
        "kelas": kelas,
        "kontak": kontak or "-",
        "eventId": event_id,
        "eventName": event['name'],
        "competitionId": comp_id,
        "competitionName": comp['name'],
        "isGroup": is_group,
        "namaKelompok": nama_kelompok if is_group else "",
        "anggotaList": anggota_list if is_group else [],
        "totalPendaftar": (1 + len(anggota_list)) if is_group else 1,
        "catatan": catatan or "-",
        "registeredAt": registered_at,
        "status": "Terdaftar"
    }

    data.setdefault('participants', []).append(new_participant)
    save_data(data)

    # Otomatis login peserta setelah berhasil mendaftar
    session['participant_id'] = user_id

    redirect_url = f"/peserta?welcome=1&auto_id={user_id}&auto_pw={user_pw}"

    return jsonify({
        "success": True,
        "autoLoggedIn": True,
        "redirectUrl": redirect_url,
        "message": "Pendaftaran berhasil! Anda telah otomatis masuk ke akun peserta.",
        "card": {
            "id": user_id,
            "password": user_pw,
            "nama": nama,
            "kelas": kelas,
            "kontak": kontak or "-",
            "eventId": event_id,
            "eventName": event['name'],
            "competitionId": comp_id,
            "competitionName": comp['name'],
            "isGroup": is_group,
            "namaKelompok": nama_kelompok if is_group else "",
            "anggotaList": anggota_list if is_group else [],
            "totalPendaftar": (1 + len(anggota_list)) if is_group else 1,
            "catatan": catatan or "-",
            "registeredAt": registered_at,
            "status": "Terdaftar"
        }
    })


def build_participant_context(found, data):
    participants = data.get('participants', [])
    event = next((e for e in data.get('events', []) if e['id'] == found['eventId']), None)
    enriched_ev = enrich_event_status(event, participants) if event else None
    comp = next(
        (c for c in enriched_ev.get('competitions', []) if c['id'] == found['competitionId']),
        None
    ) if enriched_ev else None

    label = f"{found['nama']} ({found['kelas']})"
    bracket_status = "Menunggu pengundian bagan oleh panitia."
    if comp and isinstance(comp.get('bracket'), dict):
        rounds = comp['bracket'].get('rounds', [])
        champion = comp['bracket'].get('champion', '')
        if champion and found['nama'].lower() in champion.lower():
            bracket_status = f"SELAMAT! Anda tercatat sebagai Juara ({champion})!"
        else:
            matches_found = []
            for r in rounds:
                for m in r.get('matches', []):
                    if found['nama'].lower() in (m.get('p1', '').lower() + ' ' + m.get('p2', '').lower()):
                        status_m = f"Pemenang: {m['winner']}" if m.get('winner') else "Belum bertanding"
                        matches_found.append(f"{r['name']}: {m['p1']} vs {m['p2']} ({status_m})")
            if matches_found:
                bracket_status = " | ".join(matches_found)

    norm_n = normalize_text(found.get('nama'))
    norm_k = normalize_text(found.get('kelas'))
    same_student_regs = [
        p for p in participants
        if normalize_text(p.get('nama')) == norm_n and normalize_text(p.get('kelas')) == norm_k
    ]

    return {
        "participant": found,
        "event": enriched_ev,
        "competition": comp,
        "bracketStatus": bracket_status,
        "participantLabel": label,
        "allRegistrations": same_student_regs
    }


@app.route('/api/participant/me')
def participant_me():
    pid = session.get('participant_id')
    if not pid:
        return jsonify({"authenticated": False})
    data = load_data()
    found = next((p for p in data.get('participants', []) if p.get('id') == pid), None)
    if not found:
        session.pop('participant_id', None)
        return jsonify({"authenticated": False})
    ctx = build_participant_context(found, data)
    ctx["authenticated"] = True
    return jsonify(ctx)


@app.route('/api/participant/logout', methods=['POST'])
def participant_logout():
    session.pop('participant_id', None)
    return jsonify({"success": True})


@app.route('/api/participant/switch', methods=['POST'])
def participant_switch():
    payload = request.get_json() or {}
    target_id = (payload.get('id') or '').strip().upper()
    current_id = session.get('participant_id')
    if not current_id:
        return jsonify({"success": False, "message": "Belum login."}), 401
    data = load_data()
    participants = data.get('participants', [])
    curr = next((p for p in participants if p.get('id') == current_id), None)
    target = next((p for p in participants if (p.get('id') or '').upper() == target_id), None)
    if not curr or not target:
        return jsonify({"success": False, "message": "Data peserta tidak ditemukan."}), 404
    if normalize_text(curr.get('nama')) != normalize_text(target.get('nama')) or normalize_text(curr.get('kelas')) != normalize_text(target.get('kelas')):
        return jsonify({"success": False, "message": "Tidak diizinkan."}), 403
    session['participant_id'] = target['id']
    ctx = build_participant_context(target, data)
    ctx["success"] = True
    return jsonify(ctx)


@app.route('/api/participant/login', methods=['POST'])
def participant_login():
    payload = request.get_json() or {}
    user_id = (payload.get('id') or '').strip().upper()
    password = (payload.get('password') or '').strip().upper()

    if not user_id or not password:
        return jsonify({"success": False, "message": "ID User dan Password wajib diisi."}), 400

    data = load_data()
    participants = data.get('participants', [])
    found = next(
        (p for p in participants if (p.get('id') or '').upper() == user_id and (p.get('password') or '').upper() == password),
        None
    )

    if not found:
        return jsonify({
            "success": False,
            "message": "ID Peserta atau Password salah. Periksa kembali Kartu Lomba Anda."
        }), 401

    session['participant_id'] = found['id']
    ctx = build_participant_context(found, data)
    ctx["success"] = True
    return jsonify(ctx)


def get_all_panitia():
    """Menggabungkan akun panitia dari db.json dengan akun default dan Vercel Environment Variables."""
    data = load_data()
    panitia_list = list(data.get('panitia', []))
    existing_ids = {p.get('id', '').upper() for p in panitia_list}

    # Akun default panitia/panitia selalu aktif
    if 'PANITIA' not in existing_ids:
        panitia_list.insert(0, {
            "id": "panitia",
            "name": "Panitia Utama",
            "password": "panitia",
            "role": "Super Admin"
        })
        existing_ids.add('PANITIA')

    # 1. Cek dari VERCEL Key: PANITIA_ID dan PANITIA_PASSWORD (paling simpel)
    env_id = os.environ.get('PANITIA_ID', '').strip()
    env_pw = os.environ.get('PANITIA_PASSWORD', '').strip()
    if env_id and env_pw:
        env_name = os.environ.get('PANITIA_NAME', 'Admin Utama Vercel').strip()
        env_role = os.environ.get('PANITIA_ROLE', 'Super Admin').strip()
        # Jika id sudah ada di list, update passwordnya dari key vercel
        matched = next((p for p in panitia_list if p.get('id', '').upper() == env_id.upper()), None)
        if matched:
            matched['password'] = env_pw
            matched['name'] = env_name
            matched['role'] = env_role
        else:
            panitia_list.append({
                "id": env_id,
                "name": env_name,
                "password": env_pw,
                "role": env_role
            })
            existing_ids.add(env_id.upper())

    # 2. Cek dari VERCEL Key: PANITIA_ADMINS (format: ID:PASSWORD:NAMA:JABATAN,ID2:PW2...)
    env_admins = os.environ.get('PANITIA_ADMINS', '').strip()
    if env_admins:
        entries = env_admins.split(',')
        for entry in entries:
            parts = [p.strip() for p in entry.split(':')]
            if len(parts) >= 2:
                p_id = parts[0]
                p_pw = parts[1]
                p_name = parts[2] if len(parts) > 2 else f"Panitia {p_id}"
                p_role = parts[3] if len(parts) > 3 else "Panitia Lomba"
                matched = next((p for p in panitia_list if p.get('id', '').upper() == p_id.upper()), None)
                if matched:
                    matched['password'] = p_pw
                    matched['name'] = p_name
                    matched['role'] = p_role
                else:
                    panitia_list.append({
                        "id": p_id,
                        "name": p_name,
                        "password": p_pw,
                        "role": p_role
                    })

    return panitia_list


@app.route('/api/panitia/me')
def panitia_me():
    panitia_id = session.get('panitia_id')
    if not panitia_id:
        return jsonify({"authenticated": False})
    panitia_list = get_all_panitia()
    found = next((p for p in panitia_list if p['id'].upper() == panitia_id.upper()), None)
    if not found:
        session.pop('panitia_id', None)
        return jsonify({"authenticated": False})
    return jsonify({
        "authenticated": True,
        "panitia": {
            "id": found['id'],
            "name": found['name'],
            "role": found['role']
        }
    })


@app.route('/api/panitia/login', methods=['POST'])
def panitia_login():
    payload = request.get_json() or {}
    panitia_id = (payload.get('id') or '').strip().upper()
    password = (payload.get('password') or '').strip()

    panitia_list = get_all_panitia()
    found = next(
        (p for p in panitia_list if (p.get('id') or '').upper() == panitia_id and p.get('password') == password),
        None
    )

    if not found:
        return jsonify({
            "success": False,
            "message": "ID Unik Panitia atau Password tidak cocok. Akses ditolak."
        }), 401

    session['panitia_id'] = found['id']
    return jsonify({
        "success": True,
        "panitia": {
            "id": found['id'],
            "name": found['name'],
            "role": found['role']
        }
    })


@app.route('/api/panitia/logout', methods=['POST'])
def panitia_logout():
    session.pop('panitia_id', None)
    return jsonify({"success": True})


@app.route('/api/panitia/toggle-event-lock', methods=['POST'])
@panitia_required
def toggle_event_lock():
    payload = request.get_json() or {}
    event_id = payload.get('eventId')
    data = load_data()
    ev = next((e for e in data.get('events', []) if e['id'] == event_id), None)
    if not ev:
        return jsonify({"success": False, "message": "Event tidak ditemukan."}), 404

    ev['locked'] = not ev.get('locked', False)
    save_data(data)
    return jsonify({"success": True, "locked": ev['locked']})


@app.route('/api/panitia/update-event-schedule', methods=['POST'])
@panitia_required
def update_event_schedule():
    payload = request.get_json() or {}
    event_id = payload.get('eventId')
    deadline = (payload.get('registrationDeadline') or '').strip()
    event_date = (payload.get('eventDate') or '').strip()

    data = load_data()
    ev = next((e for e in data.get('events', []) if e['id'] == event_id), None)
    if not ev:
        return jsonify({"success": False, "message": "Event tidak ditemukan."}), 404

    if deadline:
        ev['registrationDeadline'] = deadline
    if event_date:
        ev['eventDate'] = event_date
    save_data(data)
    return jsonify({"success": True, "message": f"Jadwal {ev['name']} berhasil diperbarui."})


@app.route('/api/panitia/toggle-comp-lock', methods=['POST'])
@panitia_required
def toggle_comp_lock():
    payload = request.get_json() or {}
    comp_id = payload.get('compId')
    data = load_data()
    for ev in data.get('events', []):
        for c in ev.get('competitions', []):
            if c['id'] == comp_id:
                c['locked'] = not c.get('locked', False)
                save_data(data)
                return jsonify({"success": True, "locked": c['locked']})
    return jsonify({"success": False, "message": "Cabang lomba tidak ditemukan."}), 404


@app.route('/api/panitia/update-juknis', methods=['POST'])
@panitia_required
def update_juknis():
    payload = request.get_json() or {}
    comp_id = payload.get('compId')
    juknis = (payload.get('juknis') or '').strip()
    if not juknis:
        return jsonify({"success": False, "message": "Isi juknis tidak boleh kosong."}), 400

    data = load_data()
    for ev in data.get('events', []):
        for c in ev.get('competitions', []):
            if c['id'] == comp_id:
                c['juknis'] = juknis
                save_data(data)
                return jsonify({"success": True, "message": "Kisi-kisi & juknis berhasil diperbarui."})
    return jsonify({"success": False, "message": "Cabang lomba tidak ditemukan."}), 404


@app.route('/api/panitia/add-competition', methods=['POST'])
@panitia_required
def add_competition():
    payload = request.get_json() or {}
    event_id = (payload.get('eventId') or '').strip()
    name = (payload.get('name') or '').strip()
    category = (payload.get('category') or 'Individu').strip()
    juknis = (payload.get('juknis') or '').strip()

    if not event_id or not name:
        return jsonify({"success": False, "message": "Event utama dan Nama lomba wajib diisi."}), 400

    data = load_data()
    ev = next((e for e in data.get('events', []) if e['id'] == event_id), None)
    if not ev:
        return jsonify({"success": False, "message": "Event tidak ditemukan."}), 404

    is_group = bool(payload.get('isGroup')) or 'tim' in category.lower() or 'kelompok' in category.lower()
    min_members = int(payload.get('minMembers') or (2 if is_group else 1))

    comp_id = f"{event_id[:4]}-{int(datetime.now().timestamp())}-{secrets.randbelow(99)}"
    new_comp = {
        "id": comp_id,
        "name": name,
        "category": category or ("Kelompok" if is_group else "Individu"),
        "isGroup": is_group,
        "minMembers": min_members,
        "locked": False,
        "juknis": juknis or "1. Peserta wajib hadir 15 menit sebelum lomba dimulai.\n2. Mengikuti seluruh arahan juri dan panitia.",
        "bracket": {"rounds": [], "champion": ""}
    }
    ev.setdefault('competitions', []).append(new_comp)
    save_data(data)
    return jsonify({"success": True, "competition": new_comp, "message": f"Lomba '{name}' berhasil ditambahkan ke {ev['name']}!"})


def build_knockout_tree(entries, comp_id):
    """Build power-of-2 knockout bracket rounds from a shuffled list of entries."""
    total = len(entries)
    size = 4 if total <= 4 else (8 if total <= 8 else 16)
    padded = list(entries) + ["BYE"] * (size - total)

    round_names_map = {
        16: ["Perdelapan Final", "Perempat Final", "Semifinal", "Grand Final"],
        8: ["Perempat Final", "Semifinal", "Grand Final"],
        4: ["Semifinal", "Grand Final"]
    }
    round_names = round_names_map[size]

    rounds = []
    # First round with actual entries
    first_matches = []
    for idx in range(0, size, 2):
        p1 = padded[idx]
        p2 = padded[idx + 1]
        winner = ""
        if p2 == "BYE" and p1 != "BYE":
            winner = p1
        elif p1 == "BYE" and p2 != "BYE":
            winner = p2
        first_matches.append({
            "id": f"{comp_id}-r0-m{idx // 2}",
            "p1": p1,
            "p2": p2,
            "winner": winner
        })
    rounds.append({"name": round_names[0], "matches": first_matches})

    # Subsequent rounds
    prev_matches = first_matches
    for r_idx in range(1, len(round_names)):
        next_matches = []
        for m_idx in range(0, len(prev_matches), 2):
            left = prev_matches[m_idx]
            right = prev_matches[m_idx + 1]
            p1 = left["winner"] if left["winner"] else f"Menunggu Pemenang {m_idx + 1}"
            p2 = right["winner"] if right["winner"] else f"Menunggu Pemenang {m_idx + 2}"
            next_matches.append({
                "id": f"{comp_id}-r{r_idx}-m{m_idx // 2}",
                "p1": p1,
                "p2": p2,
                "winner": ""
            })
        rounds.append({"name": round_names[r_idx], "matches": next_matches})
        prev_matches = next_matches

    return {"rounds": rounds, "champion": ""}


@app.route('/api/panitia/bracket/update', methods=['POST'])
@panitia_required
def update_bracket():
    payload = request.get_json() or {}
    comp_id = payload.get('compId')
    action = payload.get('action')

    data = load_data()
    target_comp = None
    for ev in data.get('events', []):
        for c in ev.get('competitions', []):
            if c['id'] == comp_id:
                target_comp = c
                break
        if target_comp:
            break

    if not target_comp:
        return jsonify({"success": False, "message": "Cabang lomba tidak ditemukan."}), 404

    if action == 'shuffle':
        registered = [
            f"{p['nama']} ({p['kelas']})"
            for p in data.get('participants', [])
            if p.get('competitionId') == comp_id
        ]
        used_simulation = False
        if len(registered) < 2:
            # Fill with remaining slots so committee can still preview/demonstrate bracket shuffling
            sim_pool = ["Kelas X-A", "Kelas X-B", "Kelas XI-IPA 1", "Kelas XII-IPS 2"]
            for s in sim_pool:
                if len(registered) >= 4:
                    break
                if s not in registered:
                    registered.append(s)
            used_simulation = True

        # Cryptographically fair shuffle
        shuffled = list(registered)
        for i in range(len(shuffled) - 1, 0, -1):
            j = secrets.randbelow(i + 1)
            shuffled[i], shuffled[j] = shuffled[j], shuffled[i]

        target_comp['bracket'] = build_knockout_tree(shuffled, comp_id)
        save_data(data)
        msg = (
            "Bagan diacak! (Catatan: karena pendaftar < 2, slot dilengkapi kelas simulasi.)"
            if used_simulation
            else f"Bagan berhasil diacak secara acak untuk {len(shuffled)} peserta terdaftar!"
        )
        return jsonify({"success": True, "bracket": target_comp['bracket'], "message": msg})

    elif action == 'advance':
        round_idx = payload.get('roundIndex')
        match_idx = payload.get('matchIndex')
        winner = (payload.get('winner') or '').strip()

        bracket = target_comp.get('bracket')
        if not isinstance(bracket, dict) or not bracket.get('rounds'):
            return jsonify({"success": False, "message": "Bagan belum dibuat."}), 400

        rounds = bracket['rounds']
        if round_idx is None or match_idx is None or round_idx >= len(rounds):
            return jsonify({"success": False, "message": "Indeks babak tidak valid."}), 400

        matches = rounds[round_idx]['matches']
        if match_idx >= len(matches):
            return jsonify({"success": False, "message": "Indeks pertandingan tidak valid."}), 400

        match = matches[match_idx]
        if winner not in (match['p1'], match['p2']) or winner == "BYE" or winner.startswith("Menunggu"):
            return jsonify({"success": False, "message": "Peserta belum valid untuk dimajukan."}), 400

        match['winner'] = winner

        # Propagate winner to next round cleanly
        if round_idx + 1 < len(rounds):
            next_match_idx = match_idx // 2
            next_match = rounds[round_idx + 1]['matches'][next_match_idx]
            if match_idx % 2 == 0:
                next_match['p1'] = winner
            else:
                next_match['p2'] = winner
            # Clear downstream winner if participants changed
            next_match['winner'] = ""
            bracket['champion'] = ""
        else:
            # Grand Final winner!
            bracket['champion'] = winner

        save_data(data)
        msg = (
            f"Juara Utama ditetapkan: {winner}!"
            if round_idx == len(rounds) - 1
            else f"{winner} berhasil maju ke babak {rounds[round_idx + 1]['name']}!"
        )
        return jsonify({"success": True, "bracket": bracket, "message": msg})

    elif action == 'reset':
        target_comp['bracket'] = {"rounds": [], "champion": ""}
        save_data(data)
        return jsonify({"success": True, "bracket": target_comp['bracket'], "message": "Bagan berhasil dikosongkan."})

    return jsonify({"success": False, "message": "Aksi bagan tidak dikenali."}), 400


@app.route('/api/panitia/list', methods=['GET'])
@panitia_required
def list_panitia():
    panitia_list = get_all_panitia()
    # Mask password sedikit untuk preview
    safe_list = []
    for p in panitia_list:
        safe_list.append({
            "id": p.get('id'),
            "name": p.get('name'),
            "role": p.get('role', 'Panitia Lomba'),
            "password": p.get('password')
        })
    return jsonify({"success": True, "panitia": safe_list})


@app.route('/api/panitia/add', methods=['POST'])
@panitia_required
def add_new_panitia():
    payload = request.get_json() or {}
    new_id = (payload.get('id') or '').strip()
    new_pw = (payload.get('password') or '').strip()
    new_name = (payload.get('name') or '').strip()
    new_role = (payload.get('role') or 'Panitia Lomba').strip()

    if not new_id or not new_pw or not new_name:
        return jsonify({"success": False, "message": "ID Panitia, Nama, dan Password wajib diisi."}), 400

    data = load_data()
    panitia_list = data.get('panitia', [])
    if any(p.get('id', '').upper() == new_id.upper() for p in panitia_list):
        return jsonify({"success": False, "message": f"Panitia dengan ID '{new_id}' sudah ada."}), 400

    new_member = {
        "id": new_id,
        "name": new_name,
        "password": new_pw,
        "role": new_role
    }
    panitia_list.append(new_member)
    data['panitia'] = panitia_list
    save_data(data)

    return jsonify({"success": True, "message": f"Akun panitia '{new_name}' ({new_id}) berhasil ditambahkan!", "panitia": new_member})


@app.route('/api/panitia/delete', methods=['POST'])
@panitia_required
def delete_panitia():
    payload = request.get_json() or {}
    target_id = (payload.get('id') or '').strip().upper()
    current_id = session.get('panitia_id', '').upper()

    if target_id == current_id:
        return jsonify({"success": False, "message": "Anda tidak dapat menghapus akun Anda sendiri saat sedang login."}), 400

    if target_id == 'PANITIA':
        return jsonify({"success": False, "message": "Akun superadmin bawaan tidak dapat dihapus."}), 400

    data = load_data()
    before = len(data.get('panitia', []))
    data['panitia'] = [p for p in data.get('panitia', []) if p.get('id', '').upper() != target_id]
    if len(data['panitia']) == before:
        return jsonify({"success": False, "message": "Akun panitia tidak ditemukan atau merupakan akun environment variable."}), 400

    save_data(data)
    return jsonify({"success": True, "message": f"Akun panitia '{target_id}' berhasil dihapus."})


@app.route('/api/panitia/participants')
@panitia_required
def get_all_participants():
    data = load_data()
    return jsonify({"participants": data.get('participants', [])})


@app.route('/api/panitia/delete-participant', methods=['POST'])
@panitia_required
def delete_participant():
    payload = request.get_json() or {}
    pid = payload.get('id')
    data = load_data()
    before = len(data.get('participants', []))
    data['participants'] = [p for p in data.get('participants', []) if p.get('id') != pid]
    if len(data['participants']) == before:
        return jsonify({"success": False, "message": "Peserta tidak ditemukan."}), 404
    save_data(data)
    return jsonify({"success": True, "message": "Data peserta berhasil dihapus."})


@app.route('/api/panitia/export-excel')
@panitia_required
def export_excel():
    event_filter = (request.args.get('eventId') or '').strip()
    data = load_data()
    participants = data.get('participants', [])
    if event_filter:
        participants = [p for p in participants if p.get('eventId') == event_filter]

    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Rekap Ayo Lomba"

    header_fill = PatternFill(start_color="1B4332", end_color="1B4332", fill_type="solid")
    zebra_fill = PatternFill(start_color="FAF7F2", end_color="FAF7F2", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    title_font = Font(name="Calibri", size=14, bold=True, color="1B4332")
    subtitle_font = Font(name="Calibri", size=10, italic=True, color="555555")
    thin_side = Side(style='thin', color='D9D3C7')
    border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)

    ws.merge_cells('A1:L1')
    ws['A1'] = "REKAPITULASI PENDAFTARAN PESERTA - AYO LOMBA"
    ws['A1'].font = title_font
    ws['A1'].alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[1].height = 28

    ws.merge_cells('A2:L2')
    filter_lbl = f" | Filter Event: {event_filter}" if event_filter else " | Semua Event"
    ws['A2'] = f"Diekspor: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')} | Total Peserta: {len(participants)}{filter_lbl}"
    ws['A2'].font = subtitle_font
    ws['A2'].alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[2].height = 20

    # NO NIS / NISN column, with Group details
    headers = [
        "No", "ID Peserta", "Password Akun", "Nama Pendaftar / Ketua",
        "Kelas", "No. Kontak / WA", "Event Utama", "Cabang Lomba",
        "Tipe Lomba", "Nama Kelompok / Tim", "Daftar Anggota Tim", "Waktu Daftar"
    ]
    ws.append([])
    ws.append(headers)
    ws.row_dimensions[4].height = 26

    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=4, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border

    for idx, p in enumerate(participants, start=1):
        is_grp = p.get('isGroup', False)
        anggota_str = ", ".join(p.get('anggotaList', [])) if is_grp and p.get('anggotaList') else (p.get('catatan', '-') if is_grp else "-")
        row_data = [
            idx,
            p.get('id', '-'),
            p.get('password', '-'),
            p.get('nama', '-'),
            p.get('kelas', '-'),
            p.get('kontak', '-'),
            p.get('eventName', '-'),
            p.get('competitionName', '-'),
            "Kelompok" if is_grp else "Individu",
            p.get('namaKelompok', '-') if is_grp else "-",
            anggota_str,
            p.get('registeredAt', '-')
        ]
        ws.append(row_data)
        r_num = 4 + idx
        ws.row_dimensions[r_num].height = 21
        for c_idx in range(1, len(row_data) + 1):
            c = ws.cell(row=r_num, column=c_idx)
            c.border = border
            if idx % 2 == 0:
                c.fill = zebra_fill
            if c_idx in (1, 2, 3, 5, 9):
                c.alignment = Alignment(horizontal="center", vertical="center")
            else:
                c.alignment = Alignment(horizontal="left", vertical="center")

    for col_idx in range(1, len(headers) + 1):
        col_letter = openpyxl.utils.get_column_letter(col_idx)
        max_len = 0
        for row_idx in range(4, 5 + len(participants)):
            val = str(ws.cell(row=row_idx, column=col_idx).value or '')
            if len(val) > max_len:
                max_len = len(val)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 12)

    stream = BytesIO()
    wb.save(stream)
    stream.seek(0)

    filename = f"rekap_ayolomba_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return send_file(
        stream,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


if __name__ == '__main__':
    print("Ayo Lomba berjalan di http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=False)
