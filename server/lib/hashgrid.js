module.exports = class HashGrid {
    static stride = 1 << 16;
    static maxCellsPerEntity = 256;

    cells = new Map();
    entities = new Set();
    largeEntities = new Set();
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.output = new Set();
    }

    insert(entity, minX, minY, maxX, maxY) {
        const startX = minX >> this.cellSize;
        const startY = minY >> this.cellSize;
        const endX = maxX >> this.cellSize;
        const endY = maxY >> this.cellSize;
        const cellCount = (endX - startX + 1) * (endY - startY + 1);
        this.entities.add(entity);

        // Very large growth tanks can cover a huge number of mostly empty
        // cells. Keep them in a small side set and check their AABBs per query.
        if (cellCount > HashGrid.maxCellsPerEntity) {
            this.largeEntities.add(entity);
            return;
        }

        for (let x = startX; x <= endX; x++) {
            for (let y = startY; y <= endY; y++) {
                const key = x + y * HashGrid.stride;
                const cell = this.cells.get(key);
                if (cell === undefined) {
                    this.cells.set(key, [entity]);
                } else {
                    cell.push(entity);
                }
            }
        }
    }

    query(minX, minY, maxX, maxY) {
        const cells = this.cells;
        const cellSize = this.cellSize;
        const stride = HashGrid.stride;
        const startX = minX >> cellSize;
        const startY = minY >> cellSize;
        const endX = maxX >> cellSize;
        const endY = maxY >> cellSize;

        this.output.clear();
        const cellCount = (endX - startX + 1) * (endY - startY + 1);
        const addIfOverlapping = entity => {
            if (!entity.bond && entity.minX < maxX && entity.maxX > minX && entity.minY < maxY && entity.maxY > minY) {
                this.output.add(entity);
            }
        };

        if (cellCount > HashGrid.maxCellsPerEntity) {
            for (const entity of this.entities) addIfOverlapping(entity);
            return this.output;
        }

        for (let x = startX; x <= endX; x++) {
            for (let y = startY; y <= endY; y++) {
                const key = x + y * stride;
                const cell = cells.get(key);
                if (cell !== undefined) {
                    for (const entity of cell) {
                        addIfOverlapping(entity);
                    }
                }
            }
        }
        for (const entity of this.largeEntities) addIfOverlapping(entity);
        return this.output;
    }

    clear() {
        this.cells.clear();
        this.entities.clear();
        this.largeEntities.clear();
    }
}
