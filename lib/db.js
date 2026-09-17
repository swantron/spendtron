const { neon } = require("@neondatabase/serverless");

// Lazy init — same reasoning as curbspec's lib/db.ts: evaluating neon() at
// module load time would throw before DATABASE_URL exists.
let _sql = null;

function sql() {
  if (!_sql) {
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

module.exports = { sql };
