// Callbacks must be synchronous: DatabaseSync commits only after all writes succeed.
export function transaction(db,action,{immediate=true}={}){
  db.exec(immediate?'BEGIN IMMEDIATE':'BEGIN');
  try{
    const result=action();
    db.exec('COMMIT');
    return result;
  }catch(error){
    db.exec('ROLLBACK');
    throw error;
  }
}

export function pruneEvents(db){
  db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)');
}
