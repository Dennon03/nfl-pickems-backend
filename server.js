// backend/index.js
import express from "express";
import cors from "cors";
import axios from "axios";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://nfl-pickems.vercel.app",
    ],
    credentials: true,
  })
);
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ------------------ Supabase Client ------------------
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side key
);

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
  try {
    for (let week = 1; week <= 18; week++) {
      const events = await fetchApiSportsGames(season, week);
      for (const event of events) {
        const { error: upsertError } = await supabase
          .from("game_results")
          .upsert(
            {
              game_id: event.game_code,
              week: event.week,
              home_team: event.home_team,
              away_team: event.away_team,
              home_score: event.home_score,
              away_score: event.away_score,
              winner_team: event.winner_team,
              game_date: event.game_date,
              updated_at: new Date(),
            },
            { onConflict: "game_id" }
          );
        if (upsertError) console.error("Game upsert error:", upsertError);

        if (event.winner_team) {
          // Optionally replace with SQL function for performance
          const { error } = await supabase
            .from("user_picks")
            .update({
              is_correct: true,
            })
            .eq("game_id", event.game_code)
            .ilike("picked_team", event.winner_team);
          if (error) console.error("Error updating picks correctness:", error);
        }
      }
    }
    console.log("Game results & user picks updated successfully.");
  } catch (err) {
    console.error("Error updating game results:", err);
  }
}

// ------------------ Cron Job ------------------
cron.schedule("0 8 * * 2,5", async () => {
  console.log("Running scheduled game update:", new Date());
  try {
    await updateGameResults();
    console.log("Game update completed successfully.");
  } catch (err) {
    console.error("Error during scheduled game update:", err);
  }
});

// ------------------ Routes ------------------

// Manual update
app.post("/update-games", async (req, res) => {
  try {
    await updateGameResults();
    res.json({ ok: true, message: "Games updated successfully" });
  } catch {
    res.status(500).json({ error: "Failed to update games" });
  }
});

// POST /login
app.post("/login", async (req, res) => {
  const { username } = req.body;
  try {
    const { data, error } = await supabase.from("users").select("*").eq("username", username);
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: "User not found", canCreate: true });
    }
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error during login" });
  }
});

// POST /create-user
app.post("/create-user", async (req, res) => {
  const { username } = req.body;
  try {
    const { data: existing } = await supabase.from("users").select("id").eq("username", username);
    if (existing?.length > 0) return res.status(409).json({ error: "Username already exists" });

    const { data, error } = await supabase.from("users").insert({ username }).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch {
    res.status(500).json({ error: "Server error during user creation" });
  }
});

// GET /games
app.get("/games", async (req, res) => {
  const { week } = req.query;
  try {
    let query = supabase.from("games").select("*").order("week_id").order("game_date");
    if (week) query = query.eq("week_id", week);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch {
    res.status(500).json({ error: "Database error fetching games" });
  }
});

// GET /validate-user/:id
app.get("/validate-user/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("users").select("*").eq("id", req.params.id).single();
    if (error?.code === "PGRST116") return res.status(404).json({ error: "User not found" });
    if (error) throw error;
    res.json(data);
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /save-picks
app.post("/save-picks", async (req, res) => {
  const { userId, week, picks } = req.body;
  try {
    const { data: games } = await supabase
      .from("games")
      .select("game_date")
      .eq("week_id", week)
      .order("game_date")
      .limit(1);

    const firstGameDate = games?.[0]?.game_date;
    if (!firstGameDate) return res.status(400).json({ error: "Invalid week or no games found." });
    if (new Date() >= new Date(firstGameDate))
      return res.status(403).json({ error: "Picks are locked for this week." });

    for (const [gameId, pickedTeam] of Object.entries(picks)) {
      await supabase.from("user_picks").upsert({
        user_id: userId,
        week,
        game_id: gameId,
        picked_team: pickedTeam,
      });
    }

    await supabase.from("user_week_picks_status").upsert({
      user_id: userId,
      week,
      has_picks: true,
      updated_at: new Date(),
    });

    res.json({ message: "Picks saved successfully" });
  } catch {
    res.status(500).json({ error: "Failed to save picks" });
  }
});

// GET /picks-status
app.get("/picks-status", async (req, res) => {
  const { userId, week } = req.query;
  if (!userId || !week) return res.status(400).json({ error: "userId and week required" });
  try {
    const { data } = await supabase
      .from("user_week_picks_status")
      .select("has_picks")
      .eq("user_id", userId)
      .eq("week", week)
      .single();
    res.json({ hasPicks: data?.has_picks || false });
  } catch {
    res.status(500).json({ error: "Failed to read picks status" });
  }
});

// POST /picks-status
app.post("/picks-status", async (req, res) => {
  const { userId, week, hasPicks } = req.body;
  if (!userId || !week || typeof hasPicks !== "boolean")
    return res.status(400).json({ error: "userId, week, hasPicks required" });
  try {
    await supabase.from("user_week_picks_status").upsert({
      user_id: userId,
      week,
      has_picks: hasPicks,
      updated_at: new Date(),
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to upsert picks status" });
  }
});

// GET /user-saved-picks
app.get("/user-saved-picks", async (req, res) => {
  const { userId, week } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    let query = supabase
      .from("user_picks")
      .select(
        "game_id, picked_team, week, games(game_code, home_team, away_team, game_date)"
      )
      .eq("user_id", userId)
      .order("week")
      .order("games.game_date");

    if (week) query = query.eq("week", week);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to fetch saved picks" });
  }
});

// GET /game-results
app.get("/game-results", async (req, res) => {
  const { gameIds } = req.query;
  if (!gameIds) return res.status(400).json({ error: "gameIds required" });
  try {
    const idsArray = gameIds.split(",");
    const { data, error } = await supabase
      .from("game_results")
      .select("game_id, home_score, away_score, winner_team, game_date")
      .in("game_id", idsArray);
    if (error) throw error;
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to fetch game results" });
  }
});

// GET /user-saved-picks-week
app.get("/user-saved-picks-week", async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: "Week required" });
  try {
    const { data, error } = await supabase
      .from("user_picks")
      .select("user_id, users(username), game_id, picked_team, game_results(winner_team)")
      .eq("week", week);
    if (error) throw error;
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to fetch picks for leaderboard" });
  }
});

// GET /user-grand-total
app.get("/user-grand-total", async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: "Week required" });
  try {
    const { data, error } = await supabase.rpc("user_grand_total", { upto_week: week });
    if (error) throw error;
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to fetch grand totals" });
  }
});

// GET /current-week
app.get("/current-week", async (req, res) => {
  try {
    const { data, error } = await supabase.from("weeks").select("id, start_date").order("start_date");
    if (error) throw error;
    if (data.length === 0) return res.json({ currentWeek: null });

    const now = new Date();
    let currentWeekId = data[0].id;
    for (let i = 0; i < data.length; i++) {
      if (now >= new Date(data[i].start_date)) currentWeekId = data[i].id;
      else break;
    }
    res.json({ currentWeek: currentWeekId });
  } catch {
    res.status(500).json({ error: "Failed to determine current week" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", time: new Date() });
});

// ------------------ Start Server ------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
