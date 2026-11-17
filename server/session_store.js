// Keeps FM-DX logins (admin / tune password) across restarts.
// Works like express-session's normal memory store, but sessions that hold a login are also
// written to a small file (only readable by the FM-DX user) and loaded again at start.
// Visitors without a login are kept in memory only. Logins unused for 30 days are dropped.
const fs = require('fs');

module.exports = function (session, file) {
    const KEEP_DAYS = 30;
    class FileStore extends session.Store {
        constructor() {
            super();
            this.map = new Map();        // id -> { json, t }
            this.timer = null;
            try {
                const now = Date.now(), data = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const [id, v] of Object.entries(data)) if (v && v.json && now - v.t < KEEP_DAYS * 864e5) this.map.set(id, v);
            } catch (_) { /* no file yet */ }
            // forget visitors without a login after a day without visits (and old logins after 30 days)
            const prune = setInterval(() => {
                const now = Date.now();
                for (const [id, v] of this.map) {
                    const login = FileStore.hasLogin(v.json);
                    if (now - v.t > (login ? KEEP_DAYS * 864e5 : 864e5)) { this.map.delete(id); if (login) this.persist(); }
                }
            }, 3600e3);
            if (prune.unref) prune.unref();
        }
        static hasLogin(json) {
            try { const s = JSON.parse(json); return Object.keys(s).some(k => k !== 'cookie' && s[k]); } catch (_) { return false; }
        }
        persist() {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                const out = {};
                for (const [id, v] of this.map) if (FileStore.hasLogin(v.json)) out[id] = v;
                try {
                    fs.writeFileSync(file + '.tmp', JSON.stringify(out), { mode: 0o600 });
                    fs.renameSync(file + '.tmp', file);
                } catch (_) { /* ignore: logins then just live in memory */ }
            }, 1000);
            if (this.timer.unref) this.timer.unref();
        }
        get(id, cb) {
            const v = this.map.get(id);
            if (!v) return cb(null, null);
            let s;
            try { s = JSON.parse(v.json); } catch (_) { return cb(null, null); }
            if (s.cookie && s.cookie.expires && new Date(s.cookie.expires) <= new Date()) { this.destroy(id, () => cb(null, null)); return; }
            cb(null, s);
        }
        set(id, sess, cb) {
            const json = JSON.stringify(sess), old = this.map.get(id);
            this.map.set(id, { json, t: Date.now() });
            if (FileStore.hasLogin(json) || (old && FileStore.hasLogin(old.json))) this.persist();
            if (cb) cb(null);
        }
        touch(id, sess, cb) {
            const v = this.map.get(id);
            if (v) {
                const day = Date.now() - v.t > 864e5;
                v.t = Date.now();
                if (day && FileStore.hasLogin(v.json)) this.persist();   // refresh "last used" now and then
            }
            if (cb) cb(null);
        }
        destroy(id, cb) {
            const v = this.map.get(id);
            this.map.delete(id);
            if (v && FileStore.hasLogin(v.json)) this.persist();
            if (cb) cb(null);
        }
        length(cb) { cb(null, this.map.size); }
        clear(cb) { this.map.clear(); this.persist(); if (cb) cb(null); }
    }
    return new FileStore();
};
