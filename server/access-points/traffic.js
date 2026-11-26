// Engine counters are cumulative, including flows that close between samples.
// Keep the last observation per engine generation to avoid double counting.
export class AccessPointTraffic{
 constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS access_point_traffic (point_id TEXT NOT NULL,client_id TEXT NOT NULL,upload REAL NOT NULL DEFAULT 0,download REAL NOT NULL DEFAULT 0,generation TEXT,last_upload REAL NOT NULL DEFAULT 0,last_download REAL NOT NULL DEFAULT 0,PRIMARY KEY(point_id,client_id))`);}
 observe(pointId,generation,users){
  this.db.exec('BEGIN');
  try{for(const [email,value] of Object.entries(users || {})){
   if(!email.endsWith('@freedomgate'))continue;const id=email.slice(0,-12);
   const upload=Math.max(0,Number(value.uplink)||0),download=Math.max(0,Number(value.downlink)||0);if(!Number.isFinite(upload)||!Number.isFinite(download))continue;
   const old=this.db.prepare('SELECT * FROM access_point_traffic WHERE point_id=? AND client_id=?').get(pointId,id);
   const same=old?.generation===generation;
   this.db.prepare(`INSERT INTO access_point_traffic VALUES (?,?,?,?,?,?,?) ON CONFLICT(point_id,client_id) DO UPDATE SET upload=excluded.upload,download=excluded.download,generation=excluded.generation,last_upload=excluded.last_upload,last_download=excluded.last_download`).run(pointId,id,(old?.upload || 0)+Math.max(0,upload-(same?old.last_upload:0)),(old?.download || 0)+Math.max(0,download-(same?old.last_download:0)),generation,upload,download);
  }this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 clients(pointId){return Object.fromEntries(this.db.prepare('SELECT client_id,upload,download FROM access_point_traffic WHERE point_id=?').all(pointId).map(row=>[row.client_id,{upload:row.upload,download:row.download}]));}
 total(pointId){const row=this.db.prepare('SELECT coalesce(sum(upload),0) upload,coalesce(sum(download),0) download FROM access_point_traffic WHERE point_id=?').get(pointId);return {...row};}
}
