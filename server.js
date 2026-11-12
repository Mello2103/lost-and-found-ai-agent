const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // We will put our HTML here later

let db;

// --- THE AI AGENT CLASS ---
class MatchingAgent {
    constructor(lostItem, tau = 0.70, k = 5) {
        this.lost = lostItem;
        this.tau = tau;
        this.k = k;
        this.nodesExplored = 0;
        this.trace = [];
        this.results = [];
        
        // Weights from your documentation
        this.W = { cat: 0.25, desc: 0.20, col: 0.15, brand: 0.15, loc: 0.15, date: 0.10 };
    }

    async run() {
        let frontier = [{ type: 'root', s_hat: 1.0, h: 0.0 }];

        while (frontier.length > 0 && this.results.length < this.k) {
            // Priority Queue sorting (Lowest h = Highest priority)
            frontier.sort((a, b) => a.h - b.h);
            let current = frontier.shift();
            this.nodesExplored++;

            // Branch and Bound Pruning
            if (current.s_hat < this.tau) {
                this.logTrace(current, 'prune_threshold');
                continue;
            }

            if (current.type === 'root') {
                await this.expandCategories(frontier);
            } else if (current.type === 'category') {
                await this.expandZones(frontier, current);
            } else if (current.type === 'zone') {
                await this.expandItems(frontier, current);
            }
        }

        this.results.sort((a, b) => b.similarity - a.similarity);

        return {
            search_id: 'search_' + Date.now(),
            nodes_explored: this.nodesExplored,
            results: this.results,
            trace: this.trace
        };
    }

    async expandCategories(frontier) {
        const categories = await db.all("SELECT id, parent_id FROM categories");
        for (let cat of categories) {
            let s_cat = await this.categoryScore(this.lost.category_id, cat.id);
            let s_hat = (this.W.cat * s_cat) + (1 - this.W.cat);
            
            frontier.push({
                type: 'category', category_id: cat.id, zone_id: null,
                s_hat: s_hat, h: 1 - s_hat
            });
        }
    }

    async expandZones(frontier, parent) {
        let s_cat = await this.categoryScore(this.lost.category_id, parent.category_id);
        const zones = await db.all("SELECT id FROM zones");
        
        for (let zone of zones) {
            let s_loc = await this.locationScore(this.lost.zone_id, zone.id);
            let s_hat = (this.W.cat * s_cat) + (this.W.loc * s_loc) + (1 - this.W.cat - this.W.loc);
            
            frontier.push({
                type: 'zone', category_id: parent.category_id, zone_id: zone.id,
                s_hat: s_hat, h: 1 - s_hat
            });
        }
    }

    async expandItems(frontier, parent) {
        const items = await db.all(
            "SELECT * FROM reports WHERE report_type = 'found' AND category_id = ? AND zone_id = ? AND status = 'open'",
            [parent.category_id, parent.zone_id]
        );

        for (let item of items) {
            // Feasibility constraint
            if (new Date(item.event_datetime) < new Date(this.lost.event_datetime)) {
                this.logTrace({ type: 'item', node_id: item.id, s_hat: 0, h: 1 }, 'prune_feasibility');
                continue;
            }

            let s = await this.calculateSimilarity(item);

            if (s < this.tau) {
                this.logTrace({ type: 'item', node_id: item.id, s_hat: s, h: 1 - s }, 'prune_threshold');
                continue;
            }

            this.results.push({
                found_id: item.id,
                similarity: s,
                path_cost: 1 - s
            });
            this.logTrace({ type: 'item', node_id: item.id, s_hat: s, h: 1 - s }, 'goal');
        }
    }

    // --- SIMILARITY CALCULATIONS ---
    async calculateSimilarity(found) {
        let s_cat = await this.categoryScore(this.lost.category_id, found.category_id);
        let s_desc = this.descriptionScore(this.lost.description_raw || '', found.description_raw || '');
        let s_col = this.colorScore(this.lost.color_id, found.color_id);
        let s_brand = this.brandScore(this.lost.brand_raw, found.brand_raw);
        let s_loc = await this.locationScore(this.lost.zone_id, found.zone_id);
        let s_date = this.dateScore(this.lost.event_datetime, found.event_datetime);

        return (this.W.cat * s_cat) + (this.W.desc * s_desc) + (this.W.col * s_col) + 
               (this.W.brand * s_brand) + (this.W.loc * s_loc) + (this.W.date * s_date);
    }

    async categoryScore(lostCatId, foundCatId) {
        if (lostCatId == foundCatId) return 1.0;
        const lost = await db.get("SELECT parent_id FROM categories WHERE id = ?", [lostCatId]);
        const found = await db.get("SELECT parent_id FROM categories WHERE id = ?", [foundCatId]);
        if (lost && found && lost.parent_id === found.parent_id) return 0.5;
        return 0.0;
    }

    descriptionScore(d1, d2) {
        if (!d1 || !d2) return 0.0;
        let t1 = d1.toLowerCase().split(/\s+/);
        let t2 = d2.toLowerCase().split(/\s+/);
        let intersection = t1.filter(x => t2.includes(x));
        let union = new Set([...t1, ...t2]);
        return intersection.length / union.size;
    }

    colorScore(c1, c2) {
        if (!c1 || !c2) return 0.5;
        return c1 === c2 ? 1.0 : 0.0;
    }

    brandScore(b1, b2) {
        if (!b1 || !b2) return 0.5;
        return b1.toLowerCase() === b2.toLowerCase() ? 1.0 : 0.0;
    }

    async locationScore(lostZoneId, foundZoneId) {
        if (lostZoneId == foundZoneId) return 1.0;
        const row = await db.get("SELECT distance FROM zone_distances WHERE zone_a = ? AND zone_b = ?", [lostZoneId, foundZoneId]);
        return row ? row.distance : 0.0;
    }

    dateScore(d1, d2) {
        let deltaHours = Math.abs(new Date(d2) - new Date(d1)) / (1000 * 60 * 60);
        let lambda = Math.log(2) / 48; // Half-life of 48 hours
        return Math.exp(-lambda * deltaHours);
    }

    logTrace(node, action) {
        this.trace.push({ ...node, action });
    }
}

// --- API ENDPOINTS ---
app.post('/api/search', async (req, res) => {
    try {
        const input = req.body;
        
        // Save the lost report to SQLite
        const result = await db.run(
            `INSERT INTO reports (report_type, category_id, zone_id, color_id, brand_raw, event_datetime, description_raw) 
             VALUES ('lost', ?, ?, ?, ?, ?, ?)`,
            [input.category_id, input.zone_id, input.color_id || null, input.brand_raw, input.event_datetime, input.description_raw]
        );
        
        // Run the AI Agent
        const agent = new MatchingAgent(input, input.tau, input.k);
        const searchResults = await agent.run();

        res.json(searchResults);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error during search" });
    }
});

// Start Server
initDB().then(database => {
    db = database;
    app.listen(3000, () => {
        console.log('AI Agent Server running on http://localhost:3000');
    });
});