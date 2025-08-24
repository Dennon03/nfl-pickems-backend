import express from "express";
import cors from "cors";
import pg from "pg";
import axios from "axios";
import cron from "node-cron";

const app = express();
app.use(cors({
  origin: [
    "http://localhost:3000",
    process.env.NEXT_PUBLIC_API_BASE 
  ],
  credentials: true,
}));
app.use(express.json());

// Connect to Postgres
const pool = new pg.Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
});
// ------------------ API-Sports Integration ------------------

const API_BASE = "https://v1.american-football.api-sports.io";
const API_KEY = process.env.API_SPORTS_KEY;
const apiHeaders = { "x-apisports-key": API_KEY };

async function fetchApiSportsGames(season = 2025, week = 1) {
  try {
    const res = await axios.get(`${API_BASE}/games`, {
      headers: apiHeaders,
      params: { league: 1, season, week },
    });
    const games = res.data.response;

    return games.map((game) => ({
      game_code: game.fixture.id.toString(),
      week,
      home_team: game.teams.home.name,
      away_team: game.teams.away.name,
      home_score: game.scores.home.total,
      away_score: game.scores.away.total,
      winner_team:
        game.scores.home.total > game.scores.away.total
          ? game.teams.home.name
          : game.scores.away.total > game.scores.home.total
          ? game.teams.away.name
          : null,
      game_date: new Date(game.fixture.date),
    }));
  } catch (err) {
    console.error("Error fetching API-Sports NFL games:", err.response?.data || err.message);
    return [];
  }
}

async function updateGameResults(season = 2025) {
  const client = await pool.connect();
  try {
    for (let week = 1; week <= 18; week++) {
      const events = await fetchApiSportsGames(season, week);
      for (const event of events) {
        await client.query(
          `INSERT INTO game_results
            (game_id, week, home_team, away_team, home_score, away_score, winner_team, game_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (game_id) DO UPDATE SET
             home_score = EXCLUDED.home_score,
             away_score = EXCLUDED.away_score,
             winner_team = EXCLUDED.winner_team,
             game_date = EXCLUDED.game_date,
             updated_at = NOW()`,
          [
            event.game_code,
            event.week,
            event.home_team,
            event.away_team,
            event.home_score,
            event.away_score,
            event.winner_team,
            event.game_date,
          ]
        );

        if (event.winner_team) {
          await client.query(
            `UPDATE user_picks
             SET is_correct = (LOWER(TRIM(picked_team)) = LOWER(TRIM($1)))
             WHERE game_id = $2`,
            [event.winner_team, event.game_code]
          );
        }
      }
    }
    console.log("Game results & user picks updated successfully.");
  } catch (err) {
    console.error("Error updating game results:", err);
  } finally {
    client.release();
  }
}

// Schedule twice a week: e.g., Tuesday 8 AM and Friday 8 AM
cron.schedule("0 8 * * 2,5", async () => {
  console.log("Running scheduled game update:", new Date());
  try {
    await updateGameResults(); 
    console.log("Game update completed successfully.");
  } catch (err) {
    console.error("Error during scheduled game update:", err);
  }
});

// Manual update endpoint
app.post("/update-games", async (req, res) => {
  try {
    await updateGameResults();
    res.json({ ok: true, message: "Games updated successfully" });
  } catch (err) {
    console.error("Failed to update games:", err);
    res.status(500).json({ error: "Failed to update games" });
  }
});

app.listen(5000,'0.0.0.0', () => {
  console.log("Server running on port 5000");
});

// POST /login
app.post("/login", async (req, res) => {
  const { username } = req.body;
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (rows.length === 0) {
      // User not found - ask client if they want to create account
      return res.status(404).json({ error: "User not found", canCreate: true });
    }
    // User found - return user info
    res.json(rows[0]);
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// POST /create-user
app.post("/create-user", async (req, res) => {
  const { username } = req.body;
  try {
    // Double check user doesn't already exist to avoid duplicates
    const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (rows.length > 0) {
      return res.status(409).json({ error: "Username already exists" });
    }

    // Insert new user
    const insertResult = await pool.query(
      "INSERT INTO users (username) VALUES ($1) RETURNING *",
      [username]
    );
    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    console.error("Create user error:", err);
    res.status(500).json({ error: "Server error during user creation" });
  }
});

app.get("/games", async (req, res) => {
  const week = req.query.week;

  try {
    let query;
    let params = [];

    if (week) {
      query = "SELECT * FROM games WHERE week_id = $1 ORDER BY game_date";
      params = [week];
    } else {
      query = "SELECT * FROM games ORDER BY week_id, game_date";
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database error fetching games" });
  }
});

app.get("/validate-user/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    // Return minimal user info or full user row
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/save-picks", async (req, res) => {
  const { userId, week, picks } = req.body;
  console.log("Received save-picks request for userId:", userId);

  try {
    const { rows } = await pool.query(
      "SELECT MIN(game_date) AS first_game FROM games WHERE week_id = $1",
      [week]
    );
    const firstGameDate = rows[0]?.first_game;

    if (!firstGameDate) {
      return res.status(400).json({ error: "Invalid week or no games found." });
    }

    const now = new Date();
    if (now >= new Date(firstGameDate)) {
      return res.status(403).json({ error: "Picks are locked for this week." });
    }

    // Save/Upsert the individual picks as you already do:
    for (const [gameId, pickedTeam] of Object.entries(picks)) {
      await pool.query(
        `INSERT INTO user_picks (user_id, week, game_id, picked_team)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, week, game_id)
         DO UPDATE SET picked_team = EXCLUDED.picked_team`,
        [userId, week, gameId, pickedTeam]
      );
    }

    // Mark the status = true (this is the key bit)
    await pool.query(
      `INSERT INTO user_week_picks_status (user_id, week, has_picks, updated_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (user_id, week)
       DO UPDATE SET has_picks = TRUE, updated_at = NOW()`,
      [userId, week]
    );

    res.json({ message: "Picks saved successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save picks" });
  }
});

// GET /picks-status?userId=4&week=1  -> { hasPicks: true|false }
app.get("/picks-status", async (req, res) => {
  const { userId, week } = req.query;
  if (!userId || !week) {
    return res.status(400).json({ error: "userId and week are required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT has_picks
       FROM user_week_picks_status
       WHERE user_id = $1 AND week = $2`,
      [userId, week]
    );

    if (rows.length === 0) {
      return res.json({ hasPicks: false });
    }
    return res.json({ hasPicks: !!rows[0].has_picks });
  } catch (err) {
    console.error("Error reading picks status:", err);
    res.status(500).json({ error: "Failed to read picks status" });
  }
});

// POST /picks-status  body: { userId, week, hasPicks }
app.post("/picks-status", async (req, res) => {
  const { userId, week, hasPicks } = req.body || {};
  if (userId == null || week == null || typeof hasPicks !== "boolean") {
    return res.status(400).json({ error: "userId, week, hasPicks are required" });
  }

  try {
    await pool.query(
      `INSERT INTO user_week_picks_status (user_id, week, has_picks, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, week)
       DO UPDATE SET has_picks = EXCLUDED.has_picks, updated_at = NOW()`,
      [userId, week, hasPicks]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error upserting picks status:", err);
    res.status(500).json({ error: "Failed to upsert picks status" });
  }
});

app.get("/user-saved-picks", async (req, res) => {
  const { userId, week } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    let query = `
      SELECT up.game_id, up.picked_team, up.week, g.game_code, g.home_team, g.away_team, g.game_date
      FROM user_picks up
      JOIN games g
        ON up.game_id = g.game_code
      WHERE up.user_id = $1
    `;
    const params = [Number(userId)];

    if (week) {
      query += " AND up.week = $2";
      params.push(Number(week));
    }

    query += " ORDER BY up.week, g.game_date";

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching user saved picks:", err);
    res.status(500).json({ error: "Failed to fetch saved picks" });
  }
});

// GET /game-results?gameIds=1,2,3
app.get("/game-results", async (req, res) => {
  const { gameIds } = req.query;
  if (!gameIds) return res.status(400).json({ error: "gameIds required" });

  try {
    const idsArray = gameIds.split(",");
    const { rows } = await pool.query(
      `SELECT game_id, home_score, away_score, winner_team, game_date
       FROM game_results
       WHERE game_id = ANY($1::text[])`,
      [idsArray]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch game results" });
  }
});

// GET /user-saved-picks-week?week=2
app.get("/user-saved-picks-week", async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: "Week is required" });

  try {
    const { rows } = await pool.query(`
      SELECT up.user_id, u.username, up.game_id, up.picked_team, gr.winner_team
      FROM user_picks up
      JOIN users u ON up.user_id = u.id
      JOIN game_results gr ON up.game_id = gr.game_id
      WHERE up.week = $1
    `, [Number(week)]);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch picks for leaderboard" });
  }
});

app.get("/user-grand-total", async (req, res) => {
  const { week } = req.query;

  if (!week) return res.status(400).json({ error: "Week is required" });

  try {
    const { rows } = await pool.query(`
      SELECT u.id AS user_id, u.username,
             COALESCE(SUM(CASE WHEN up.is_correct = TRUE THEN 1 ELSE 0 END), 0) AS grand_total_correct
      FROM users u
      LEFT JOIN user_picks up
        ON u.id = up.user_id
       AND up.week <= $1
      GROUP BY u.id, u.username
      ORDER BY grand_total_correct DESC
    `, [Number(week)]);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch grand totals" });
  }
});

// GET /current-week
app.get("/current-week", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, start_date
      FROM weeks
      ORDER BY start_date ASC
    `);

    if (rows.length === 0) return res.json({ currentWeek: null });

    const now = new Date();
    let currentWeekId = rows[0].id; // default to first week

    for (let i = 0; i < rows.length; i++) {
      const startDate = new Date(rows[i].start_date);
      if (now >= startDate) {
        currentWeekId = rows[i].id;
      } else {
        break; // stop at the first future week
      }
    }

    res.json({ currentWeek: currentWeekId });
  } catch (err) {
    console.error("Error fetching current week:", err);
    res.status(500).json({ error: "Failed to determine current week" });
  }
});
