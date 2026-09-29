// In-memory stand-in for the Sites PostgREST adapter. Local only: it lives in
// dev/ so it never enters webDirectory or functionDirectory.
const splitTop = (text, separator) => {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === separator && depth === 0) { parts.push(current); current = ''; continue; }
        current += char;
    }
    if (current) parts.push(current);
    return parts;
};

const compare = (row, condition) => {
    const index = condition.indexOf('.');
    const operator = condition.slice(index + 1, condition.indexOf('.', index + 1));
    const column = condition.slice(0, index);
    const value = condition.slice(condition.indexOf('.', index + 1) + 1);
    const cell = row[column];
    switch (operator) {
        case 'eq': return String(cell) === value;
        case 'neq': return String(cell) !== value;
        case 'gt': return Number(cell) > Number(value);
        case 'gte': return Number(cell) >= Number(value);
        case 'lt': return Number(cell) < Number(value);
        case 'ilike': return String(cell).toLowerCase().startsWith(value.replace(/%/g, ''));
        default: throw new Error(`未支持的过滤条件: ${condition}`);
    }
};

const matchesOr = (row, expression) => splitTop(expression, ',').some(term => {
    const inner = term.match(/^and\((.*)\)$/);
    const conditions = inner ? splitTop(inner[1], ',') : [term];
    return conditions.every(condition => compare(row, condition));
});

class Builder {
    constructor(store, table) {
        this.store = store;
        this.table = table;
        this.mode = null;
        this.payload = null;
        this.filters = [];
        this.orFilters = [];
        this.orders = [];
        this.count = null;
        this.returning = null;
        this.wantSingle = false;
        this.wantMaybeSingle = false;
    }

    select(columns = '*') {
        if (!this.mode) this.mode = 'select';
        this.returning = columns;
        return this;
    }

    insert(rows) { this.mode = 'insert'; this.payload = rows; return this; }
    update(patch) { this.mode = 'update'; this.payload = patch; return this; }
    delete() { this.mode = 'delete'; return this; }
    upsert(rows, { onConflict } = {}) { this.mode = 'upsert'; this.payload = rows; this.conflict = onConflict; return this; }
    eq(column, value) { this.filters.push(row => String(row[column]) === String(value)); return this; }
    neq(column, value) { this.filters.push(row => String(row[column]) !== String(value)); return this; }
    gt(column, value) { this.filters.push(row => Number(row[column]) > Number(value)); return this; }
    in(column, values) { const list = new Set(values.map(String)); this.filters.push(row => list.has(String(row[column]))); return this; }
    ilike(column, pattern) { this.filters.push(row => String(row[column]).toLowerCase().startsWith(pattern.replace(/%/g, ''))); return this; }
    or(expression) { this.orFilters.push(expression); return this; }
    order(column, { ascending = true } = {}) { this.orders.push({ column, ascending }); return this; }
    limit(value) { this.count = value; return this; }
    single() { this.wantSingle = true; return this; }
    maybeSingle() { this.wantMaybeSingle = true; return this; }

    project(row) {
        if (!this.returning || this.returning === '*') return structuredClone(row);
        const keys = this.returning.split(',').map(key => key.trim());
        return Object.fromEntries(keys.map(key => [key, structuredClone(row[key])]));
    }

    visible() {
        const rows = this.store[this.table] || [];
        return rows.filter(row => this.filters.every(test => test(row))
            && this.orFilters.every(expression => matchesOr(row, expression)));
    }

    async run() {
        const rows = this.store[this.table];
        switch (this.mode) {
            case 'select': {
                let found = this.visible();
                for (const { column, ascending } of this.orders.slice().reverse()) {
                    found = found.slice().sort((a, b) => {
                        const left = a[column];
                        const right = b[column];
                        const numeric = typeof left === 'number' && typeof right === 'number';
                        const order = numeric ? left - right : String(left).localeCompare(String(right));
                        return ascending ? order : -order;
                    });
                }
                if (this.count !== null) found = found.slice(0, this.count);
                const data = found.map(row => this.project(row));
                if (this.wantMaybeSingle) return { data: data[0] ?? null, error: null };
                if (this.wantSingle) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116' } };
                return { data, error: null };
            }
            case 'insert': {
                const created = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(row => structuredClone(row));
                rows.push(...created);
                return { data: this.returning ? created.map(row => this.project(row)) : null, error: null };
            }
            case 'upsert': {
                const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
                const applied = [];
                for (const row of incoming) {
                    const existing = rows.find(stored => String(stored[this.conflict]) === String(row[this.conflict]));
                    if (existing) Object.assign(existing, row);
                    else rows.push(structuredClone(row));
                    applied.push(existing ?? row);
                }
                return { data: this.returning ? applied.map(row => this.project(row)) : null, error: null };
            }
            case 'update': {
                const targets = this.visible();
                for (const row of targets) Object.assign(row, this.payload);
                return { data: this.returning ? targets.map(row => this.project(row)) : null, error: null };
            }
            case 'delete': {
                const targets = this.visible();
                this.store[this.table] = rows.filter(row => !targets.includes(row));
                return { data: this.returning ? targets.map(row => this.project(row)) : null, error: null };
            }
            default:
                throw new Error(`未支持的调用序列: ${this.mode}`);
        }
    }

    then(resolve, reject) { return this.run().then(resolve, reject); }
}

export function createFakeSupabase(tables) {
    const store = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows]));
    return {
        store,
        from(table) {
            if (!store[table]) throw new Error(`缺少表: ${table}`);
            return new Builder(store, table);
        },
    };
}
