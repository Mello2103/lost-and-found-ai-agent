const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function initDB() {
    // This creates the file 'lost_found.sqlite' in your folder
    const db = await open({
        filename: './lost_found.sqlite',
        driver: sqlite3.Database
    });

    // Create Tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER
        );

        CREATE TABLE IF NOT EXISTS zones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS zone_distances (
            zone_a INTEGER,
            zone_b INTEGER,
            distance REAL,
            PRIMARY KEY (zone_a, zone_b)
        );

        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_type TEXT NOT NULL, -- 'lost' or 'found'
            category_id INTEGER,
            zone_id INTEGER,
            color_id INTEGER,
            brand_raw TEXT,
            event_datetime TEXT,
            description_raw TEXT,
            status TEXT DEFAULT 'open'
        );
    `);

    // Seed Initial Data (Matching your documentation)
    const count = await db.get('SELECT COUNT(*) as count FROM categories');
    if (count.count === 0) {
        // Categories
        await db.run("INSERT INTO categories (id, name, parent_id) VALUES (1, 'Electronics', NULL), (2, 'Phone', 1), (3, 'Wallet', NULL)");
        // Zones
        await db.run("INSERT INTO zones (id, name) VALUES (1, 'Library'), (2, 'Canteen'), (3, 'Main Gate')");
        // Distance Matrix (Library=1.0, Canteen=0.40, Main Gate=0.00)
        await db.run(`INSERT INTO zone_distances VALUES 
            (1, 1, 1.0), (1, 2, 0.4), (1, 3, 0.0),
            (2, 1, 0.4), (2, 2, 1.0), (2, 3, 0.2),
            (3, 1, 0.0), (3, 2, 0.2), (3, 3, 1.0)
        `);
        // Sample Found Items
        await db.run(`INSERT INTO reports (report_type, category_id, zone_id, color_id, brand_raw, event_datetime, description_raw) VALUES 
            ('found', 1, 1, 1, 'Apple', '2026-11-13 10:00:00', 'Black iphone found near the library entrance'),
            ('found', 2, 2, 2, 'Samsung', '2026-11-13 12:30:00', 'Brown wallet left at canteen table'),
            ('found', 1, 1, 1, 'Apple', '2026-11-10 08:00:00', 'Old black phone')
        `);
        console.log("Database seeded successfully!");
    }
    
    return db;
}

module.exports = { initDB };