'use strict';
const { CATEGORIES } = require('./catalog-data');

// Existing category slugs remain stable so saved links and products keep working.
const DEPARTMENTS = [...CATEGORIES,
  { name: 'Baby Essentials', slug: 'baby-essentials', icon: '🍼', accent: '#697e9a', children: [
    { name: 'Feeding & Nursing', slug: 'feeding-nursing' },
    { name: 'Nappies & Changing', slug: 'nappies-changing' },
    { name: 'Strollers & Car Seats', slug: 'strollers-car-seats' },
    { name: 'Baby Care & Safety', slug: 'baby-care-safety' },
  ] },
  { name: 'Toys & Games', slug: 'toys-games', icon: '🧸', accent: '#a4733d', children: [
    { name: 'Educational Toys', slug: 'educational-toys' },
    { name: 'Dolls & Action Figures', slug: 'dolls-action-figures' },
    { name: 'Board Games & Puzzles', slug: 'board-games-puzzles' },
    { name: 'Ride-on & Outdoor Toys', slug: 'outdoor-toys' },
  ] },
  { name: 'Garden & Patio', slug: 'garden-patio', icon: '🌱', accent: '#55774a', children: [
    { name: 'Gardening & Plants', slug: 'gardening-plants' },
    { name: 'Outdoor Furniture', slug: 'outdoor-furniture' },
    { name: 'Watering & Garden Tools', slug: 'watering-garden-tools' },
    { name: 'BBQ & Outdoor Cooking', slug: 'bbq-outdoor-cooking' },
  ] },
  { name: 'Pet Supplies', slug: 'pet-supplies', icon: '🐾', accent: '#8b6c55', children: [
    { name: 'Dog Supplies', slug: 'dog-supplies' },
    { name: 'Cat Supplies', slug: 'cat-supplies' },
    { name: 'Pet Food', slug: 'pet-food' },
    { name: 'Pet Care & Grooming', slug: 'pet-care-grooming' },
  ] },
];

/** One-time, non-destructive upgrade. Never resets products or owner edits. */
function ensureDepartments(db) {
  const migration = 'catalog.all-departments.v1';
  if (!db.prepare('SELECT name FROM app_migrations WHERE name = ?').get(migration)) {
    db.transaction(() => {
      const insert = db.prepare(`INSERT OR IGNORE INTO categories
        (name, slug, parent_id, description, icon, accent, sort_order, is_active, show_in_menu)
        VALUES (?,?,?,?,?,?,?,1,1)`);
      const find = db.prepare('SELECT id FROM categories WHERE slug = ?');
      DEPARTMENTS.forEach((parent, index) => {
        insert.run(parent.name, parent.slug, null, `Explore ${parent.name.toLowerCase()} at POINTGH, with delivery across Ghana.`,
          parent.icon, parent.accent, index + 1);
        const id = find.get(parent.slug).id;
        (parent.children || []).forEach((child, childIndex) => {
          insert.run(child.name, child.slug, id, `Explore ${child.name.toLowerCase()} at POINTGH.`, null,
            parent.accent, childIndex + 1);
        });
      });
      db.prepare('INSERT INTO app_migrations (name) VALUES (?)').run(migration);
    })();
  }
  return Object.fromEntries(db.prepare('SELECT slug, id FROM categories').all().map(c => [c.slug, c.id]));
}

module.exports = { DEPARTMENTS, ensureDepartments };
