import {validUsername,validPassword} from '../shared/account-validation.js';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const roles = { admin: ['read', 'profiles:write', 'settings:write', 'users:write'], operator: ['read', 'profiles:write'], viewer: ['read'] };
export class AuthError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const hashToken = token => createHash('sha256').update(token).digest('hex');
async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 64);
  return salt + ':' + key.toString('hex');
}
function validatePassword(password) {
  if (!validPassword(password)) throw new AuthError(400, "Password must be 12–256 characters.");
}
export class Auth {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);`);
    this.dummy = passwordHash(randomBytes(32).toString('hex'));
    this.attempts = new Map();
  }
  needsSetup() { return this.db.prepare('SELECT count(*) AS n FROM users').get().n === 0; }
  users() { return this.db.prepare('SELECT id,username,role,disabled FROM users ORDER BY username').all().map(u=>({...u,disabled:!!u.disabled})); }
  async create(input, setup=false) {
    if (!input || !validUsername(input.username)) throw new AuthError(400, "Username: 3–40 Latin letters, digits, or _ . -");
    validatePassword(input.password);
    const role = setup ? 'admin' : input.role;
    if (!Object.hasOwn(roles, role)) throw new AuthError(400, "Unknown role.");
    const hash = await passwordHash(input.password);
    // Recheck after asynchronous hashing to prevent two initial administrators.
    if (setup && !this.needsSetup()) throw new AuthError(409, "An administrator has already been created.");
    const id = randomBytes(16).toString('hex');
    try { this.db.prepare('INSERT INTO users (id,username,password_hash,role) VALUES (?,?,?,?)').run(id,input.username.toLowerCase(),hash,role); }
    catch(e) { if(e.code?.includes('CONSTRAINT')) throw new AuthError(409,"This username is already in use."); throw e; }
    return this.users().find(u=>u.id===id);
  }
  async login(username, password, address) {
    const now=Date.now(), bucket=this.attempts.get(address);
    if(bucket && bucket.until>now && bucket.count>=10) throw new AuthError(429,"Too many attempts. Try again in 15 minutes.");
    const attempt=bucket?.until>now ? bucket : {count:0,until:now+900000};
    attempt.count++;this.attempts.set(address,attempt);
    // Bound limiter memory; address is the direct socket peer, never a forwarded header.
    for(const [key,value] of this.attempts) if(value.until<now) this.attempts.delete(key);
    const user=typeof username==='string' ? this.db.prepare('SELECT * FROM users WHERE username=?').get(username.toLowerCase()) : null;
    const stored=user?.password_hash || await this.dummy;
    const candidate=await passwordHash(typeof password==='string' && password.length<=256 ? password : '',stored.split(':')[0]);
    if(!timingSafeEqual(Buffer.from(candidate),Buffer.from(stored)) || !user || user.disabled) throw new AuthError(401,"Incorrect username or password.");
    this.attempts.delete(address);
    const token=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(token),user.id,csrf,now+8*3600000);
    return {token,csrf,user:{id:user.id,username:user.username,role:user.role}};
  }
  session(token) {
    if(!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare('SELECT u.id,u.username,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.disabled=0').get(hashToken(token),Date.now()) || null;
  }
  logout(token) { if(token) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hashToken(token)); }
  update(id,input) {
    const user=this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if(!user) throw new AuthError(404,"User not found.");
    const role=input.role ?? user.role, disabled=input.disabled ?? !!user.disabled;
    if(!Object.hasOwn(roles,role) || typeof disabled!=='boolean') throw new AuthError(400,"Invalid role or status.");
    if(user.role==='admin' && !user.disabled && (role!=='admin' || disabled) && this.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n<=1) throw new AuthError(409,"You cannot disable or demote the last administrator.");
    this.db.prepare('UPDATE users SET role=?,disabled=? WHERE id=?').run(role,Number(disabled),id);
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    return this.users().find(u=>u.id===id);
  }
  async changePassword(id, input) {
    validatePassword(input.password);
    const original=this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id);
    if(!original) throw new AuthError(401,"Please sign in.");
    const candidate=await passwordHash(typeof input.currentPassword==='string' && input.currentPassword.length<=256 ? input.currentPassword : '',original.password_hash.split(':')[0]);
    if(!timingSafeEqual(Buffer.from(candidate),Buffer.from(original.password_hash))) throw new AuthError(400,"The current password is incorrect.");
    const hash=await passwordHash(input.password);
    const result=this.db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(hash,id,original.password_hash);
    if(!result.changes) throw new AuthError(409,"Password already changed. Sign in again.");
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  async setPassword(id, input) {
    validatePassword(input.password);
    const user = this.db.prepare('SELECT 1 FROM users WHERE id=?').get(id);
    if (!user) throw new AuthError(404, "User not found.");
    const hash = await passwordHash(input.password);
    this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id);
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
}
