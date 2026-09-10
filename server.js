require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const XLSX    = require("xlsx");

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_TOKEN;
const PORT              = process.env.PORT || 3000;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com`;
const AUTH     = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString("base64");

const zendeskHeaders = {
  Authorization: `Basic ${AUTH}`,
  "Content-Type": "application/json",
};

// Webhook secret para validar chamadas do Zendesk
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "zbp_secret_ybera_2026";

// ─── CACHE EM MEMÓRIA DE AGENTES ─────────────────────────────────────────────
// Set com todos os agent_id conhecidos — carregado do SQLite na inicialização
// e atualizado pelo syncAgents(). Lookup O(1) sem bater no banco por linha.
let knownAgentIds = new Set();

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const dbPath = process.env.DB_PATH || "./database.sqlite";
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) return console.error("❌ DB error:", err.message);
  console.log("✅ SQLite conectado.");
});

db.serialize(() => {
  // Métricas de comentários (1 ticket por agente por dia)
  db.run(`
    CREATE TABLE IF NOT EXISTS comment_metrics (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT,
      ticket_id    TEXT,
      comment_date TEXT,
      created_at   TEXT,
      UNIQUE(agent_id, ticket_id, comment_date)
    )
  `);

  // Métricas de resoluções (1 ticket por agente por dia)
  db.run(`
    CREATE TABLE IF NOT EXISTS resolved_metrics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT,
      ticket_id     TEXT,
      resolved_date TEXT,
      created_at    TEXT,
      UNIQUE(agent_id, ticket_id, resolved_date)
    )
  `);

  // Checkpoint incremental
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id              INTEGER PRIMARY KEY,
      last_event_time INTEGER
    )
  `);
  db.run(`INSERT OR IGNORE INTO sync_state (id, last_event_time) VALUES (1, 0)`);

  // Cadastro de agentes buscado automaticamente do Zendesk
  db.run(`
    CREATE TABLE IF NOT EXISTS known_agents (
      agent_id   TEXT PRIMARY KEY,
      name       TEXT,
      email      TEXT,
      role       TEXT,
      synced_at  TEXT
    )
  `);
});

// ─── HELPERS GERAIS ───────────────────────────────────────────────────────────

function todaySP() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

function timestampToDateSP(ts) {
  return new Date(ts * 1000).toLocaleDateString("sv-SE", {
    timeZone: "America/Sao_Paulo",
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getLastEventTime() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT last_event_time FROM sync_state WHERE id = 1`, (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.last_event_time : 0);
    });
  });
}

function setLastEventTime(ts) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE sync_state SET last_event_time = ? WHERE id = 1`,
      [ts],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function insertMetric(agentId, ticketId, commentDate) {
  return new Promise((resolve) => {
    db.run(
      `INSERT OR IGNORE INTO comment_metrics (agent_id, ticket_id, comment_date, created_at)
       VALUES (?, ?, ?, ?)`,
      [String(agentId), String(ticketId), commentDate, new Date().toISOString()],
      function (err) {
        if (err) { console.error("❌ Erro ao inserir métrica:", err.message); resolve(0); }
        else resolve(this.changes);
      }
    );
  });
}

function insertResolved(agentId, ticketId, resolvedDate) {
  return new Promise((resolve) => {
    db.run(
      `INSERT OR IGNORE INTO resolved_metrics (agent_id, ticket_id, resolved_date, created_at)
       VALUES (?, ?, ?, ?)`,
      [String(agentId), String(ticketId), resolvedDate, new Date().toISOString()],
      function (err) {
        if (err) { console.error("❌ Erro ao inserir resolução:", err.message); resolve(0); }
        else resolve(this.changes);
      }
    );
  });
}

// ─── SYNC DE AGENTES ──────────────────────────────────────────────────────────

/**
 * Busca todos os agentes e admins do Zendesk e salva no SQLite + cache em memória.
 * Chamada automaticamente na inicialização e uma vez por dia.
 */
async function syncAgents() {
  console.log("\n👥 Sincronizando lista de agentes do Zendesk...");

  try {
    let url = `${BASE_URL}/api/v2/users.json?role[]=agent&role[]=admin&per_page=100`;
    let total = 0;
    const now = new Date().toISOString();

    while (url) {
      let response;
      try {
        response = await axios.get(url, { headers: zendeskHeaders });
      } catch (err) {
        if (err.response?.status === 429) {
          const wait = parseInt(err.response.headers["retry-after"] || "60", 10);
          console.warn(`⚠️  Rate limit no sync de agentes. Aguardando ${wait}s...`);
          await sleep(wait * 1000);
          continue;
        }
        throw err;
      }

      const users = response.data.users || [];

      for (const user of users) {
        const id = String(user.id);

        // Salva/atualiza no SQLite
        await new Promise((resolve) => {
          db.run(
            `INSERT INTO known_agents (agent_id, name, email, role, synced_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(agent_id) DO UPDATE SET
               name      = excluded.name,
               email     = excluded.email,
               role      = excluded.role,
               synced_at = excluded.synced_at`,
            [id, user.name, user.email, user.role, now],
            resolve
          );
        });

        // Adiciona ao cache em memória
        knownAgentIds.add(id);
        total++;
      }

      url = response.data.next_page || null;
      if (url) await sleep(500);
    }

    console.log(`✅ ${total} agentes/admins sincronizados e em cache.`);
  } catch (err) {
    console.error("❌ Erro ao sincronizar agentes:", err.response?.data || err.message);
  }
}

/**
 * Carrega agentes já salvos no SQLite para o cache em memória.
 * Roda na inicialização antes do primeiro sync de comentários.
 */
function loadAgentsFromDB() {
  return new Promise((resolve) => {
    db.all(`SELECT agent_id FROM known_agents`, (err, rows) => {
      if (err) { console.error("❌ Erro ao carregar agentes do DB:", err.message); return resolve(); }
      rows.forEach((r) => knownAgentIds.add(r.agent_id));
      console.log(`📋 ${knownAgentIds.size} agentes carregados do banco para o cache.`);
      resolve();
    });
  });
}

// ─── SYNC DE COMENTÁRIOS ──────────────────────────────────────────────────────

async function syncComments() {
  console.log("\n🔄 Iniciando sync incremental de comentários...");

  // Garante que o cache de agentes está populado
  if (knownAgentIds.size === 0) {
    console.log("⚠️  Cache de agentes vazio. Rodando syncAgents primeiro...");
    await syncAgents();
  }

  try {
    let startTime = await getLastEventTime();

    if (!startTime || startTime === 0) {
      const todayStr = todaySP();
      startTime = Math.floor(new Date(`${todayStr}T00:00:00-03:00`).getTime() / 1000);
      console.log(`ℹ️  Primeiro sync. Início: ${new Date(startTime * 1000).toISOString()}`);
    } else {
      console.log(`ℹ️  Continuando do timestamp: ${new Date(startTime * 1000).toISOString()}`);
    }

    let url = `${BASE_URL}/api/v2/incremental/ticket_events.json?start_time=${startTime}&include=comment_events,ticket_events`;
    let totalInserted  = 0;
    let totalProcessed = 0;
    let totalSkipped   = 0; // end-users ignorados
    let newEndTime     = startTime;
    let pageCount      = 0;

    while (url) {
      pageCount++;
      console.log(`📄 Página ${pageCount}...`);

      let response;
      try {
        response = await axios.get(url, { headers: zendeskHeaders });
      } catch (err) {
        if (err.response?.status === 429) {
          const wait = parseInt(err.response.headers["retry-after"] || "60", 10);
          console.warn(`⚠️  Rate limit (429). Aguardando ${wait}s...`);
          await sleep(wait * 1000);
          continue;
        }
        throw err;
      }

      const data         = response.data;
      const ticketEvents = data.ticket_events || [];

      if (ticketEvents.length === 0) console.log("ℹ️  Nenhum evento nesta página.");

      for (const ticketEvent of ticketEvents) {
        const ticketId  = ticketEvent.ticket_id;
        const timestamp = ticketEvent.timestamp || ticketEvent.created_at;

        // Atualiza maior timestamp visto
        if (typeof timestamp === "number" && timestamp > newEndTime) newEndTime = timestamp;
        else if (typeof timestamp === "string") {
          const ts = Math.floor(new Date(timestamp).getTime() / 1000);
          if (ts > newEndTime) newEndTime = ts;
        }

        const childEvents = ticketEvent.child_events || [];

        // Processa child_events
        for (const child of childEvents) {
          // ── COMENTÁRIOS ──────────────────────────────────────────────────
          const isComment =
            child.event_type === "Comment" ||
            child.event_type === "AgentComment" ||
            child.type       === "Comment";

          if (isComment) {
            totalProcessed++;

            // ✅ Ignora resumos automáticos de sessão do WhatsApp (gerados pelo sistema)
            // Identificados pelo texto fixo que o Zendesk gera ao encerrar a sessão
            // Ex: "Conversation with X" ou "Sessão de mensagens atualizada"
            const bodyText = (child.body || child.plain_body || "").trim();
            const isWhatsappSystemSummary =
              child.public === false && (
                bodyText.startsWith("Conversation with ") ||
                bodyText.startsWith("Sessão de mensagens atualizada") ||
                bodyText.startsWith("Session updated:") ||
                bodyText.startsWith("Conversa com ")
              );

            if (isWhatsappSystemSummary) {
              totalSkipped++;
              continue;
            }

            const authorId = String(child.author_id || child.commenter_id || "");
            if (!authorId) continue;

            if (!knownAgentIds.has(authorId)) { totalSkipped++; continue; }

            let commentDate;
            if (child.created_at) {
              commentDate = new Date(child.created_at).toLocaleDateString("sv-SE", {
                timeZone: "America/Sao_Paulo",
              });
            } else if (typeof timestamp === "number") {
              commentDate = timestampToDateSP(timestamp);
            } else {
              commentDate = todaySP();
            }

            const inserted = await insertMetric(authorId, ticketId, commentDate);
            totalInserted += inserted;
            if (inserted) {
              console.log(`  ✅ Comentário — agente:${authorId} ticket:${ticketId} data:${commentDate}`);
            }
            continue;
          }

          // ── CHAT WHATSAPP (ChatStartedEvent) ─────────────────────────────
          // Comentários via WhatsApp chegam dentro de ChatStartedEvent.value.history
          // Cada entrada com actor_type=agent é um comentário real de agente
          const isChatStarted = child.event_type === "ChatStartedEvent" || child.type === "ChatStartedEvent";

          if (isChatStarted) {
            const chatValue = child.value || {};
            const history   = chatValue.history || [];

            for (const entry of history) {
              // Só processa mensagens de agentes
              if (entry.actor_type !== "agent") continue;

              const agentId = String(entry.actor_id || "");
              if (!agentId || agentId === "-1") continue;
              if (!knownAgentIds.has(agentId)) continue;

              // Data baseada no timestamp da entrada (Unix ms)
              let commentDate;
              if (entry.timestamp) {
                commentDate = new Date(entry.timestamp).toLocaleDateString("sv-SE", {
                  timeZone: "America/Sao_Paulo",
                });
              } else if (typeof timestamp === "number") {
                commentDate = timestampToDateSP(timestamp);
              } else {
                commentDate = todaySP();
              }

              const inserted = await insertMetric(agentId, ticketId, commentDate);
              totalInserted += inserted;
              if (inserted) {
                console.log(`  ✅ WhatsApp — agente:${agentId} ticket:${ticketId} data:${commentDate}`);
              }
            }
            continue;
          }

          // ── RESOLUÇÕES ───────────────────────────────────────────────────
          // Captura quem mudou o status para "solved"
          // Estrutura real: { event_type: "Change", status: "solved", previous_value: "open"|"pending"|"hold" }
          const isResolve =
            (child.event_type === "Change" || child.type === "Change") &&
            child.status === "solved";

          if (isResolve) {
            // updater_id vem no evento pai (ticketEvent)
            const updaterId = String(ticketEvent.updater_id || "");
            if (!updaterId || updaterId === "-1") continue;
            if (!knownAgentIds.has(updaterId)) continue;

            let resolvedDate;
            if (child.created_at) {
              resolvedDate = new Date(child.created_at).toLocaleDateString("sv-SE", {
                timeZone: "America/Sao_Paulo",
              });
            } else if (typeof timestamp === "number") {
              resolvedDate = timestampToDateSP(timestamp);
            } else {
              resolvedDate = todaySP();
            }

            const insertedR = await insertResolved(updaterId, ticketId, resolvedDate);
            if (insertedR) {
              console.log(`  ✅ Resolvido — agente:${updaterId} ticket:${ticketId} data:${resolvedDate}`);
            }
          }
        }

        // Fallback: evento raiz sem child_events
        if (childEvents.length === 0) {
          const isComment =
            ticketEvent.event_type === "Comment" ||
            ticketEvent.type       === "Comment";

          if (isComment) {
            totalProcessed++;
            const authorId = String(ticketEvent.author_id || ticketEvent.commenter_id || "");

            if (authorId && ticketId) {
              // ✅ FILTRO (fallback)
              if (!knownAgentIds.has(authorId)) {
                totalSkipped++;
              } else {
                let commentDate;
                if (ticketEvent.created_at) {
                  commentDate = new Date(ticketEvent.created_at).toLocaleDateString("sv-SE", {
                    timeZone: "America/Sao_Paulo",
                  });
                } else {
                  commentDate = todaySP();
                }

                const inserted = await insertMetric(authorId, ticketId, commentDate);
                totalInserted += inserted;
                if (inserted) {
                  console.log(`  ✅ (raiz) Inserido — agente:${authorId} ticket:${ticketId} data:${commentDate}`);
                }
              }
            }
          }
        }
      }

      // Paginação
      if (data.end_of_stream || !data.next_page) {
        console.log("✅ Fim do stream incremental.");
        url = null;
      } else {
        url = data.next_page;
        await sleep(1500);
      }
    }

    if (newEndTime > startTime) {
      await setLastEventTime(newEndTime + 1);
      console.log(`💾 Checkpoint salvo: ${new Date(newEndTime * 1000).toISOString()}`);
    }

    console.log(
      `\n📊 Sync concluído — páginas:${pageCount} | comentários:${totalProcessed} | inseridos:${totalInserted} | end-users ignorados:${totalSkipped}`
    );
  } catch (err) {
    console.error("❌ Erro no sync:", err.response?.data || err.message);
  }
}

// ─── SYNC WHATSAPP (conversation_log) ────────────────────────────────────────
//
// Busca tickets WhatsApp abertos hoje e extrai mensagens de agentes
// via /api/v2/tickets/:id/conversation_log
//

async function syncWhatsAppMessages() {
  console.log("\n📱 Iniciando sync de mensagens WhatsApp...");

  try {
    const today = todaySP();

    // Busca tickets WhatsApp atualizados hoje
    // Busca tickets WhatsApp via múltiplos canais possíveis
    let tickets = [];
    const queries = [
      `type:ticket+via:whatsapp+updated>=${today}`,
      `type:ticket+channel:whatsapp+updated>=${today}`,
      `type:ticket+via_id:72+updated>=${today}`
    ];

    for (const query of queries) {
      const searchUrl = `${BASE_URL}/api/v2/search.json?query=${query}&per_page=100`;
      try {
        const searchResponse = await axios.get(searchUrl, { headers: zendeskHeaders });
        const results = searchResponse.data?.results || [];
        if (results.length > 0) {
          // Deduplica por ID
          const existingIds = new Set(tickets.map(t => t.id));
          results.forEach(t => { if (!existingIds.has(t.id)) tickets.push(t); });
          console.log(`📊 Query "${query}" retornou ${results.length} tickets`);
        }
      } catch (err) {
        if (err.response?.status === 429) {
          const wait = parseInt(err.response.headers["retry-after"] || "60", 10);
          console.warn(`⚠️  Rate limit na busca WhatsApp. Aguardando ${wait}s...`);
          await sleep(wait * 1000);
        }
        // Continua para próxima query mesmo se falhar
      }
      await sleep(500);
    }

    // Fallback: busca por grupo BPO que atende WhatsApp
    if (tickets.length === 0) {
      console.log("ℹ️  Queries diretas retornaram 0. Tentando busca por grupo BPO...");
      const groupUrl = `${BASE_URL}/api/v2/search.json?query=type:ticket+group_id:48720150685203+updated>=${today}&per_page=100`;
      try {
        const groupRes = await axios.get(groupUrl, { headers: zendeskHeaders });
        tickets = groupRes.data?.results || [];
        console.log(`📊 Busca por grupo retornou ${tickets.length} tickets`);
      } catch (err) {
        console.warn("⚠️  Busca por grupo falhou:", err.response?.data || err.message);
      }
    }

    console.log(`📊 Total: ${tickets.length} tickets WhatsApp encontrados hoje`);

    let totalInserted = 0;

    for (const ticket of tickets) {
      const ticketId = String(ticket.id);

      // Busca o conversation_log do ticket
      let logUrl = `${BASE_URL}/api/v2/tickets/${ticketId}/conversation_log`;
      
      while (logUrl) {
        let logResponse;
        try {
          logResponse = await axios.get(logUrl, {
            headers: { ...zendeskHeaders, Accept: "application/json" }
          });
        } catch (err) {
          if (err.response?.status === 429) {
            const wait = parseInt(err.response.headers["retry-after"] || "60", 10);
            console.warn(`⚠️  Rate limit no conversation_log. Aguardando ${wait}s...`);
            await sleep(wait * 1000);
            continue;
          }
          if (err.response?.status === 404) break; // ticket sem conversation_log
          throw err;
        }

        const events = logResponse.data?.events || [];

        for (const event of events) {
          // Só processa mensagens de agentes reais
          if (event.author?.type !== "agent") continue;
          if (event.type !== "Messaging::ConversationMessage") continue;

          const agentId = String(event.author["zen:support:user_id"] || "");
          if (!agentId || agentId === "-1") continue;
          if (!knownAgentIds.has(agentId)) continue;

          const commentDate = new Date(event.created_at).toLocaleDateString("sv-SE", {
            timeZone: "America/Sao_Paulo",
          });

          // Só conta mensagens de hoje
          if (commentDate !== today) continue;

          const inserted = await insertMetric(agentId, ticketId, commentDate);
          if (inserted) {
            totalInserted++;
            console.log(`  ✅ WhatsApp — agente:${agentId} (${event.author.display_name}) ticket:${ticketId} data:${commentDate}`);
          }
        }

        // Paginação do conversation_log
        const nextPage = logResponse.data?.links?.next;
        logUrl = nextPage || null;
        if (logUrl) await sleep(300);
      }

      await sleep(300); // Respeita rate limit entre tickets
    }

    console.log(`✅ Sync WhatsApp concluído — ${totalInserted} novos comentários inseridos`);
  } catch (err) {
    console.error("❌ Erro no sync WhatsApp:", err.response?.data || err.message);
  }
}

// ─── AUTO SYNC ────────────────────────────────────────────────────────────────

async function startAutoSync() {
  // 1. Carrega agentes já salvos no banco para o cache (instantâneo, sem chamada Zendesk)
  await loadAgentsFromDB();

  // 2. Se o banco estava vazio (primeira vez), busca agentes do Zendesk agora
  if (knownAgentIds.size === 0) {
    await syncAgents();
  }

  // 3. Agenda refresh diário da lista de agentes (a cada 24h)
  setInterval(syncAgents, 24 * 60 * 60 * 1000);

  // 4. Primeiro sync de comentários: aguarda 2 minutos
  console.log("⏱️  Sync de comentários iniciará em 2 minutos...");
  await sleep(2 * 60 * 1000);
  await syncComments();

  // 5. Repete a cada 1 minuto
  setInterval(syncComments, 1 * 60 * 1000);

  // 6. Sync WhatsApp: aguarda 3 minutos e roda a cada 5 minutos
  console.log("⏱️  Sync WhatsApp iniciará em 3 minutos...");
  setTimeout(async () => {
    await syncWhatsAppMessages();
    setInterval(syncWhatsAppMessages, 2 * 60 * 1000);
  }, 3 * 60 * 1000);
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

// Status geral
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Zendesk Metrics Backend",
    version: "2.0.0",
    timezone: "America/Sao_Paulo",
    todaySP: todaySP(),
    agentsCached: knownAgentIds.size,
  });
});

// Testa autenticação Zendesk
app.get("/test-zendesk", async (req, res) => {
  try {
    const r = await axios.get(`${BASE_URL}/api/v2/users/me.json`, { headers: zendeskHeaders });
    res.json({ ok: true, user: r.data.user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

// Info do agente autenticado
app.get("/me", async (req, res) => {
  try {
    const r = await axios.get(`${BASE_URL}/api/v2/users/me.json`, { headers: zendeskHeaders });
    const u = r.data.user;
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Tickets únicos comentados hoje por um agente específico
app.get("/metrics/today/:agentId", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();

  db.get(
    `SELECT COUNT(*) AS total FROM comment_metrics
     WHERE agent_id = ? AND comment_date = ?`,
    [String(agentId), today],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, date: today, ticketsCommented: row?.total ?? 0 });
    }
  );
});

// Tickets resolvidos hoje pelo agente (quem realmente resolveu)
app.get("/resolved/today/:agentId", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();

  db.get(
    `SELECT COUNT(*) AS total FROM resolved_metrics
     WHERE agent_id = ? AND resolved_date = ?`,
    [String(agentId), today],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, date: today, ticketsResolved: row?.total ?? 0 });
    }
  );
});

// Tickets resolvidos em range de datas
app.get("/resolved/range/:agentId", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  if (start > today || end > today) {
    return res.json({ agentId, start, end, ticketsResolved: 0 });
  }

  db.get(
    `SELECT COUNT(*) AS total FROM resolved_metrics
     WHERE agent_id = ? AND resolved_date >= ? AND resolved_date <= ?`,
    [String(agentId), start, end],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, start, end, ticketsResolved: row?.total ?? 0 });
    }
  );
});

// Lista ticket IDs resolvidos em range
app.get("/resolved/range/:agentId/tickets", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  if (start > today || end > today) {
    return res.json({ agentId, start, end, ticketIds: [] });
  }

  db.all(
    `SELECT ticket_id FROM resolved_metrics
     WHERE agent_id = ? AND resolved_date >= ? AND resolved_date <= ?`,
    [String(agentId), start, end],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, start, end, ticketIds: rows.map((r) => parseInt(r.ticket_id, 10)) });
    }
  );
});


// Lista de ticket IDs comentados hoje pelo agente (para o painel abrir detalhes)
app.get("/metrics/today/:agentId/tickets", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();
  db.all(
    `SELECT ticket_id FROM comment_metrics WHERE agent_id = ? AND comment_date = ?`,
    [String(agentId), today],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, date: today, ticketIds: rows.map((r) => parseInt(r.ticket_id, 10)) });
    }
  );
});


// Contagem de tickets comentados por agente em um range de datas
// GET /metrics/range/:agentId?start=2026-05-01&end=2026-05-12
app.get("/metrics/range/:agentId", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  // Bloqueia datas futuras
  if (start > today || end > today) {
    return res.json({ agentId, start, end, ticketsCommented: 0 });
  }

  db.get(
    `SELECT COUNT(*) AS total FROM comment_metrics
     WHERE agent_id = ? AND comment_date >= ? AND comment_date <= ?`,
    [String(agentId), start, end],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, start, end, ticketsCommented: row?.total ?? 0 });
    }
  );
});

// Lista ticket IDs comentados por agente em um range de datas
// GET /metrics/range/:agentId/tickets?start=2026-05-01&end=2026-05-12
app.get("/metrics/range/:agentId/tickets", (req, res) => {
  const { agentId } = req.params;
  const today = todaySP();
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  if (start > today || end > today) {
    return res.json({ agentId, start, end, ticketIds: [] });
  }

  db.all(
    `SELECT ticket_id FROM comment_metrics
     WHERE agent_id = ? AND comment_date >= ? AND comment_date <= ?`,
    [String(agentId), start, end],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ agentId, start, end, ticketIds: rows.map((r) => parseInt(r.ticket_id, 10)) });
    }
  );
});

// Todos os agentes hoje com nome e email
app.get("/metrics/today", (req, res) => {
  const today = todaySP();

  db.all(
    `SELECT cm.agent_id, ka.name, ka.email, COUNT(*) AS total
     FROM comment_metrics cm
     LEFT JOIN known_agents ka ON ka.agent_id = cm.agent_id
     WHERE cm.comment_date = ?
     GROUP BY cm.agent_id
     ORDER BY total DESC`,
    [today],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ date: today, agents: rows });
    }
  );
});

// Lista todos os agentes conhecidos no banco
app.get("/agents", (req, res) => {
  db.all(
    `SELECT agent_id, name, email, role, synced_at FROM known_agents ORDER BY name`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ total: rows.length, agents: rows });
    }
  );
});

// Força resync da lista de agentes manualmente
app.get("/sync-agents", async (req, res) => {
  res.json({ message: "Sync de agentes iniciado em background. Verifique os logs." });
  await syncAgents();
});

// Sync manual de comentários
app.get("/sync-comments", async (req, res) => {
  res.json({ message: "Sync de comentários iniciado em background. Verifique os logs." });
  await syncComments();
});

// Sync manual de WhatsApp
app.get("/sync-whatsapp", async (req, res) => {
  res.json({ message: "Sync WhatsApp iniciado em background. Verifique os logs." });
  await syncWhatsAppMessages();
});

// Estado do checkpoint
app.get("/sync-state", (req, res) => {
  db.get(`SELECT * FROM sync_state WHERE id = 1`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      lastEventTime: row?.last_event_time,
      lastEventTimeISO: row?.last_event_time
        ? new Date(row.last_event_time * 1000).toISOString()
        : null,
    });
  });
});

// Últimas métricas inseridas com nome do agente
app.get("/debug/recent", (req, res) => {
  const limit = parseInt(req.query.limit || "20", 10);
  db.all(
    `SELECT cm.*, ka.name, ka.email
     FROM comment_metrics cm
     LEFT JOIN known_agents ka ON ka.agent_id = cm.agent_id
     ORDER BY cm.id DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ count: rows.length, rows });
    }
  );
});

// Reset do checkpoint
app.post("/admin/reset-sync", (req, res) => {
  db.run(`UPDATE sync_state SET last_event_time = 0 WHERE id = 1`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Checkpoint resetado. Próximo sync começa do início do dia." });
  });
});

// Remove métricas de end-users (registros inseridos antes do filtro existir)
app.post("/admin/clean-metrics", (req, res) => {
  // Primeiro conta quantos serão removidos
  db.get(
    `SELECT COUNT(*) AS total FROM comment_metrics
     WHERE agent_id NOT IN (SELECT agent_id FROM known_agents)`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      const toRemove = row?.total ?? 0;

      if (toRemove === 0) {
        return res.json({
          message: "Nenhum registro sujo encontrado. Banco já está limpo.",
          removed: 0,
        });
      }

      // Remove os registros sujos
      db.run(
        `DELETE FROM comment_metrics
         WHERE agent_id NOT IN (SELECT agent_id FROM known_agents)`,
        function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });

          console.log(`🧹 Limpeza: ${this.changes} registros de end-users removidos.`);
          res.json({
            message: `Limpeza concluída.`,
            removed: this.changes,
          });
        }
      );
    }
  );
});

// ─── RELATÓRIO DE PRODUTIVIDADE ──────────────────────────────────────────────
//
// GET /report/productivity?start=2026-05-01&end=2026-05-31
// Retorna dados consolidados por grupo e agente para geração do Excel
//

app.get("/report/productivity", (req, res) => {
  const today = todaySP();
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  if (start > end) {
    return res.status(400).json({ error: "start deve ser anterior ou igual a end" });
  }

  // Busca todos os dias no range
  const daysQuery = `
    SELECT DISTINCT comment_date
    FROM comment_metrics
    WHERE comment_date >= ? AND comment_date <= ?
    ORDER BY comment_date ASC
  `;

  // Busca resumo por agente e dia
  const summaryQuery = `
    SELECT 
      cm.agent_id,
      ka.name,
      ka.email,
      cm.comment_date,
      COUNT(*) AS total_tickets
    FROM comment_metrics cm
    LEFT JOIN known_agents ka ON ka.agent_id = cm.agent_id
    WHERE cm.comment_date >= ? AND cm.comment_date <= ?
    GROUP BY cm.agent_id, cm.comment_date
    ORDER BY ka.name, cm.comment_date
  `;

  // Busca lista de tickets por agente e dia
  const ticketsQuery = `
    SELECT 
      cm.agent_id,
      ka.name,
      ka.email,
      cm.comment_date,
      cm.ticket_id
    FROM comment_metrics cm
    LEFT JOIN known_agents ka ON ka.agent_id = cm.agent_id
    WHERE cm.comment_date >= ? AND cm.comment_date <= ?
    ORDER BY ka.name, cm.comment_date, cm.ticket_id
  `;

  db.all(daysQuery, [start, end], (err, days) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all(summaryQuery, [start, end], (err2, summary) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.all(ticketsQuery, [start, end], (err3, tickets) => {
        if (err3) return res.status(500).json({ error: err3.message });

        res.json({
          period: { start, end },
          days: days.map(d => d.comment_date),
          summary,
          tickets
        });
      });
    });
  });
});

// ─── RELATÓRIO EXCEL ─────────────────────────────────────────────────────────
//
// GET /report/excel?start=2026-05-01&end=2026-05-31
// Gera e retorna arquivo .xlsx para download direto
//

app.get("/report/excel", async (req, res) => {
  const today = todaySP();
  const start = req.query.start || today;
  const end   = req.query.end   || today;

  // IDs dos grupos definidos no sistema
  const GROUPS = [
    { id: "48720150685203", name: "Atendentes BPO - Permanentes" },
    { id: "46550548509331", name: "Equipe Online" }
  ];

  try {
    // 1. Busca membros de cada grupo do Zendesk
    const groupAgents = {};
    for (const group of GROUPS) {
      try {
        const membRes = await axios.get(
          `${BASE_URL}/api/v2/groups/${group.id}/memberships.json`,
          { headers: zendeskHeaders }
        );
        const userIds = (membRes.data.group_memberships || []).map(m => String(m.user_id));
        groupAgents[group.name] = userIds;
      } catch (e) {
        groupAgents[group.name] = [];
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // 2. Busca agentes conhecidos do banco
    const agents = await new Promise((resolve, reject) => {
      db.all(`SELECT agent_id, name, email FROM known_agents ORDER BY name`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    const agentMap = {};
    agents.forEach(a => { agentMap[a.agent_id] = a; });

    // 3. Busca todos os dias do período
    const days = await new Promise((resolve, reject) => {
      db.all(
        `SELECT DISTINCT comment_date FROM comment_metrics
         WHERE comment_date >= ? AND comment_date <= ?
         ORDER BY comment_date ASC`,
        [start, end],
        (err, rows) => err ? reject(err) : resolve(rows.map(r => r.comment_date))
      );
    });

    // 4. Busca resumo por agente/dia
    const summary = await new Promise((resolve, reject) => {
      db.all(
        `SELECT agent_id, comment_date, COUNT(*) AS total
         FROM comment_metrics
         WHERE comment_date >= ? AND comment_date <= ?
         GROUP BY agent_id, comment_date`,
        [start, end],
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });
    const summaryMap = {};
    summary.forEach(r => {
      if (!summaryMap[r.agent_id]) summaryMap[r.agent_id] = {};
      summaryMap[r.agent_id][r.comment_date] = r.total;
    });

    // 5. Busca tickets por agente/dia
    const tickets = await new Promise((resolve, reject) => {
      db.all(
        `SELECT agent_id, comment_date, ticket_id
         FROM comment_metrics
         WHERE comment_date >= ? AND comment_date <= ?
         ORDER BY agent_id, comment_date, ticket_id`,
        [start, end],
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });
    const ticketsMap = {};
    tickets.forEach(r => {
      const key = `${r.agent_id}|${r.comment_date}`;
      if (!ticketsMap[key]) ticketsMap[key] = [];
      ticketsMap[key].push(r.ticket_id);
    });

    // 6. Gera o workbook
    const wb = XLSX.utils.book_new();

    for (const group of GROUPS) {
      const memberIds = groupAgents[group.name] || [];
      const groupAgentList = agents.filter(a => memberIds.includes(a.agent_id));

      if (groupAgentList.length === 0) continue;

      // ── Aba Resumo do grupo ──────────────────────────────────────────
      const summaryHeader = ["Agente", "Email", ...days, "TOTAL", "Média/dia", "Dias trabalhados"];
      const summaryRows   = [summaryHeader];

      groupAgentList.forEach(agent => {
        const id = agent.agent_id;
        const dayTotals = days.map(d => summaryMap[id]?.[d] || 0);
        const total = dayTotals.reduce((s, v) => s + v, 0);
        if (total === 0) return; // pula agentes sem atividade no período
        const diasTrab = dayTotals.filter(v => v > 0).length;
        const media = diasTrab > 0 ? parseFloat((total / diasTrab).toFixed(1)) : 0;
        summaryRows.push([agent.name, agent.email || "", ...dayTotals, total, media, diasTrab]);
      });

      // Linha de totais do grupo
      const totalsRow = ["TOTAL GERAL", ""];
      days.forEach(d => {
        const dayTotal = summary
          .filter(r => r.comment_date === d && memberIds.includes(r.agent_id))
          .reduce((s, r) => s + r.total, 0);
        totalsRow.push(dayTotal);
      });
      const grandTotal = summary
        .filter(r => memberIds.includes(r.agent_id))
        .reduce((s, r) => s + r.total, 0);
      totalsRow.push(grandTotal, "", "");
      summaryRows.push(totalsRow);

      const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
      const sheetNameSummary = group.name.substring(0, 20) + " - Resumo";
      XLSX.utils.book_append_sheet(wb, wsSummary, sheetNameSummary);

      // ── Aba Tickets do grupo ─────────────────────────────────────────
      const ticketRows = [["Agente", "Email", "Data", "Ticket ID", "Total do dia"]];

      groupAgentList.forEach(agent => {
        const id = agent.agent_id;
        days.forEach(d => {
          const key = `${id}|${d}`;
          const tIds = ticketsMap[key] || [];
          if (tIds.length === 0) return;
          tIds.forEach((tid, idx) => {
            ticketRows.push([
              idx === 0 ? agent.name : "",
              idx === 0 ? (agent.email || "") : "",
              idx === 0 ? d : "",
              tid,
              idx === 0 ? tIds.length : ""
            ]);
          });
        });
      });

      const wsTickets = XLSX.utils.aoa_to_sheet(ticketRows);
      const sheetNameTickets = group.name.substring(0, 20) + " - Tickets";
      XLSX.utils.book_append_sheet(wb, wsTickets, sheetNameTickets);
    }

    // ── Aba completa ─────────────────────────────────────────────────────
    const allRows = [["Grupo", "Agente", "Email", "Data", "Ticket ID"]];
    tickets.forEach(row => {
      const agent = agentMap[row.agent_id];
      const groupName = GROUPS.find(g => (groupAgents[g.name] || []).includes(row.agent_id))?.name || "Outros";
      allRows.push([
        groupName,
        agent?.name || row.agent_id,
        agent?.email || "",
        row.comment_date,
        row.ticket_id
      ]);
    });
    const wsAll = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, wsAll, "Detalhamento Completo");

    // 7. Gera o buffer e envia
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const fileName = `produtividade_${start}_${end}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);

    console.log(`📊 Relatório Excel gerado: ${fileName}`);
  } catch (err) {
    console.error("❌ Erro ao gerar Excel:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK DO ZENDESK ──────────────────────────────────────────────────────
//
// Recebe eventos em tempo real do Zendesk quando um ticket é atualizado.
// Captura comentários de agentes via WhatsApp que não aparecem no incremental.
//
// POST /webhook/ticket-updated
//
app.post("/webhook/ticket-updated", async (req, res) => {
  // Valida o secret para evitar chamadas não autorizadas
  const secret = req.headers["x-zendesk-webhook-secret"] || req.query.secret;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body;

  // DEBUG — loga o body completo para inspecionar estrutura real
  console.log("🔔 WEBHOOK RECEBIDO:");
  console.log(JSON.stringify(body, null, 2));

  try {
    const ticketId  = String(body.ticket_id || body.id || "");
    const authorId  = String(body.author_id || "");
    const commentBody = body.comment?.body || body.comment?.plain_body || "";
    const isPublic  = body.comment?.public;
    const via       = body.comment?.via?.channel || body.via?.channel || "";
    const createdAt = body.comment?.created_at || body.created_at || new Date().toISOString();

    if (!ticketId || !authorId) {
      return res.status(400).json({ error: "ticket_id e author_id são obrigatórios" });
    }

    // Ignora end-users
    if (!knownAgentIds.has(authorId)) {
      return res.json({ status: "ignored", reason: "not an agent" });
    }

    // Ignora resumos automáticos de sessão WhatsApp
    const isSystemSummary =
      isPublic === false && (
        commentBody.startsWith("Conversation with ") ||
        commentBody.startsWith("Sessão de mensagens atualizada") ||
        commentBody.startsWith("Session updated:") ||
        commentBody.startsWith("Conversa com ")
      );

    if (isSystemSummary) {
      return res.json({ status: "ignored", reason: "whatsapp system summary" });
    }

    // Data no fuso SP
    const commentDate = new Date(createdAt).toLocaleDateString("sv-SE", {
      timeZone: "America/Sao_Paulo",
    });

    const inserted = await insertMetric(authorId, ticketId, commentDate);

    if (inserted) {
      console.log(`  ✅ Webhook — agente:${authorId} ticket:${ticketId} via:${via} data:${commentDate}`);
    }

    res.json({ status: "ok", inserted: inserted === 1 });
  } catch (err) {
    console.error("❌ Erro no webhook:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🚀 Zendesk Metrics Backend v2.0 rodando na porta ${PORT}`);
  console.log(`📅 Hoje (SP): ${todaySP()}`);
  await startAutoSync();
});