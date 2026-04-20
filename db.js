import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id              SERIAL PRIMARY KEY,
      twilio_number   VARCHAR(20)  UNIQUE NOT NULL,
      business_name   VARCHAR(100) NOT NULL,
      trade           VARCHAR(50)  DEFAULT 'trades',
      hours           VARCHAR(200) DEFAULT 'Mon–Fri 8am–5pm, Sat 9am–1pm',
      service_area    VARCHAR(200) DEFAULT 'Edmonton and surrounding area',
      callout_fee     VARCHAR(100),
      job1            VARCHAR(200),
      job2            VARCHAR(200),
      faq             TEXT,
      owner_name      VARCHAR(100),
      owner_email     VARCHAR(100),
      owner_phone     VARCHAR(20),
      plan            VARCHAR(20)  DEFAULT 'essential',
      active          BOOLEAN      DEFAULT true,
      created_at             TIMESTAMP    DEFAULT NOW(),
      google_refresh_token   TEXT
    );
    -- Add column if upgrading existing table
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
  `);
  console.log("[DB] clients table ready");
}

export async function getClientByNumber(twilioNumber) {
  const { rows } = await pool.query(
    "SELECT * FROM clients WHERE twilio_number = $1 AND active = true",
    [twilioNumber]
  );
  return rows[0] || null;
}

export async function getAllClients() {
  const { rows } = await pool.query(
    "SELECT * FROM clients ORDER BY created_at DESC"
  );
  return rows;
}

export async function createClient(data) {
  const { rows } = await pool.query(
    `INSERT INTO clients
      (twilio_number, business_name, trade, hours, service_area,
       callout_fee, job1, job2, faq, owner_name, owner_email, owner_phone, plan)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      data.twilio_number, data.business_name, data.trade || "trades",
      data.hours, data.service_area, data.callout_fee || null,
      data.job1 || null, data.job2 || null, data.faq || null,
      data.owner_name || null, data.owner_email || null,
      data.owner_phone || null, data.plan || "essential",
    ]
  );
  return rows[0];
}

export async function updateClient(id, data) {
  const { rows } = await pool.query(
    `UPDATE clients SET
       twilio_number=$1, business_name=$2, trade=$3, hours=$4, service_area=$5,
       callout_fee=$6, job1=$7, job2=$8, faq=$9, owner_name=$10,
       owner_email=$11, owner_phone=$12, plan=$13, active=$14
     WHERE id=$15 RETURNING *`,
    [
      data.twilio_number, data.business_name, data.trade, data.hours,
      data.service_area, data.callout_fee || null, data.job1 || null,
      data.job2 || null, data.faq || null, data.owner_name || null,
      data.owner_email || null, data.owner_phone || null,
      data.plan, data.active ?? true, id,
    ]
  );
  return rows[0];
}

export async function deleteClient(id) {
  await pool.query("DELETE FROM clients WHERE id = $1", [id]);
}
