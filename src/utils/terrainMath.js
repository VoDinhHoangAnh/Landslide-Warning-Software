/**
 * terrainMath.js
 * Core Calculus Engine for Spatial Morphometry based on Horn's Method (1981).
 * Designed for real-time calculation in Mapbox GL JS.
 */

const RAD2DEG = 180 / Math.PI;

/**
 * Validates the 3x3 elevation grid.
 * Returns false if any required cell is missing, null, or undefined.
 * @param {Array<number>} grid - Array of 9 elevation values.
 * 
 * Z indices mapping:
 * 0(NW)  1(N)  2(NE)
 * 3(W)   4(C)  5(E)
 * 6(SW)  7(S)  8(SE)
 */
export const isValidGrid = (grid) => {
    if (!grid || grid.length !== 9) return false;
    return grid.every((z) => z !== null && z !== undefined && !isNaN(z));
};

/**
 * Calculates the first-order partial derivatives (dz/dx and dz/dy) using Horn's method.
 * @param {Array<number>} grid - 3x3 elevation grid (meters)
 * @param {number} dx - Cell size in X direction (meters)
 * @param {number} dy - Cell size in Y direction (meters)
 * @returns {Object|null} { dz_dx, dz_dy } or null if invalid
 */
export const calculateDerivatives = (grid, dx, dy) => {
    if (!isValidGrid(grid) || !dx || !dy) return null;

    const [z1, z2, z3, z4, z5, z6, z7, z8, z9] = grid;

    // Rate of change in x direction (West to East)
    const dz_dx = ((z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)) / (8 * dx);
    
    // Rate of change in y direction (South to North)
    const dz_dy = ((z1 + 2 * z2 + z3) - (z7 + 2 * z8 + z9)) / (8 * dy);

    return { dz_dx, dz_dy };
};

/**
 * Calculates Slope in degrees.
 * @param {number} dz_dx - Partial derivative in X
 * @param {number} dz_dy - Partial derivative in Y
 * @returns {number} Slope in degrees (0 to 90)
 */
export const calculateSlope = (dz_dx, dz_dy) => {
    const riseRun = Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy);
    return Math.atan(riseRun) * RAD2DEG;
};

/**
 * Calculates Aspect in degrees (0-360, 0=North, 90=East)
 * Uses the robust Compass Heading formula: atan2(-dz_dx, -dz_dy)
 * @param {number} dz_dx - Partial derivative in X (East-West)
 * @param {number} dz_dy - Partial derivative in Y (North-South)
 * @returns {number} Aspect in degrees (-1 if flat)
 */
export const calculateAspect = (dz_dx, dz_dy) => {
    if (dz_dx === 0 && dz_dy === 0) return -1; // Flat terrain

    // atan2(E, N) calculates the angle from the positive Y-axis (North) 
    // clockwise to the downhill direction vector (-dz_dx, -dz_dy).
    let aspectDeg = Math.atan2(-dz_dx, -dz_dy) * RAD2DEG;
    
    // Normalize to 0-360 range
    if (aspectDeg < 0) aspectDeg += 360;
    
    return aspectDeg;
};

/**
 * Calculates Terrain Ruggedness Index (TRI).
 * Uses Mean Absolute Difference between center and 8 neighbors for performance.
 * @param {Array<number>} grid - 3x3 elevation grid
 * @returns {number|null} TRI value (meters)
 */
export const calculateTRI = (grid) => {
    if (!isValidGrid(grid)) return null;
    
    const center = grid[4];
    let sumDiff = 0;
    
    for (let i = 0; i < 9; i++) {
        if (i !== 4) {
            sumDiff += Math.abs(grid[i] - center);
        }
    }
    
    return sumDiff / 8;
};

/**
 * Calculates Topographic Position Index (TPI).
 * Positive = Ridge/Gờ, Negative = Valley/Khe, near 0 = Flat/Slope.
 * @param {Array<number>} grid - 3x3 elevation grid
 * @returns {number|null} TPI value (meters)
 */
export const calculateTPI = (grid) => {
    if (!isValidGrid(grid)) return null;
    
    const center = grid[4];
    let sumNeighbors = 0;
    
    for (let i = 0; i < 9; i++) {
        if (i !== 4) {
            sumNeighbors += grid[i];
        }
    }
    
    return center - (sumNeighbors / 8);
};

/**
 * Calculates Plan Curvature (contour curvature).
 * Positive = convex (diverging flow), Negative = concave (converging flow), 0 = linear.
 * @param {Array<number>} grid 
 * @param {number} dx 
 * @param {number} dy 
 * @returns {number|null} Plan curvature (* 100 for readability)
 */
export const calculateCurvature = (grid, dx, dy) => {
    if (!isValidGrid(grid) || !dx || !dy) return null;

    const [z1, z2, z3, z4, z5, z6, z7, z8, z9] = grid;

    // Second derivatives (Zevenbergen & Thorne coefficients)
    const D = ((z4 + z6) / 2 - z5) / (dx * dx);
    const E = ((z2 + z8) / 2 - z5) / (dy * dy);
    const F = (-z1 + z3 + z7 - z9) / (4 * dx * dy);
    const G = (-z4 + z6) / (2 * dx);
    const H = (z2 - z8) / (2 * dy);

    const denominator = G * G + H * H;
    if (denominator === 0) return 0; // Flat

    const planCurv = - (2 * (D * H * H + E * G * G - F * G * H)) / denominator;
    
    return planCurv * 100; // Scaled for readability
};