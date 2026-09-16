export interface LogisticModel {
  intercept: number;
  weights: number[];
  means: number[];
  scales: number[];
}

const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-10;
// A small intercept penalty keeps the fit finite when every calibration label agrees.
const INTERCEPT_PENALTY_SHARE = 1e-3;

/** Deterministic Newton-Raphson fit of L2-regularized logistic regression on standardized features. */
export function fitLogistic(rows: number[][], targets: number[], l2: number): LogisticModel {
  const width = rows[0]?.length ?? 0;
  const means = Array.from({ length: width }, (_, column) => mean(rows.map((row) => row[column]!)));
  const scales = means.map((center, column) => {
    const deviation = Math.sqrt(mean(rows.map((row) => (row[column]! - center) ** 2)));
    return deviation > 1e-12 ? deviation : 1;
  });
  const design = rows.map((row) => [
    1,
    ...row.map((value, column) => (value - means[column]!) / scales[column]!),
  ]);
  const beta = Array.from({ length: width + 1 }, () => 0);
  const penalty = beta.map((_, index) => (index === 0 ? l2 * INTERCEPT_PENALTY_SHARE : l2));

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const gradient = beta.map((value, index) => -penalty[index]! * value);
    const hessian = beta.map((_, row) =>
      beta.map((__, column) => (row === column ? penalty[row]! : 0)),
    );
    for (const [index, x] of design.entries()) {
      const probability = sigmoid(dot(beta, x));
      const residual = targets[index]! - probability;
      const weight = probability * (1 - probability);
      for (let row = 0; row < x.length; row += 1) {
        gradient[row]! += x[row]! * residual;
        for (let column = 0; column < x.length; column += 1)
          hessian[row]![column]! += weight * x[row]! * x[column]!;
      }
    }
    const step = solve(hessian, gradient);
    let largest = 0;
    for (let index = 0; index < beta.length; index += 1) {
      beta[index]! += step[index]!;
      largest = Math.max(largest, Math.abs(step[index]!));
    }
    if (largest < TOLERANCE) break;
  }
  return { intercept: beta[0]!, weights: beta.slice(1), means, scales };
}

export function predictLogistic(model: LogisticModel, row: number[]) {
  const linear = row.reduce(
    (total, value, column) =>
      total + model.weights[column]! * ((value - model.means[column]!) / model.scales[column]!),
    model.intercept,
  );
  return sigmoid(linear);
}

function sigmoid(value: number) {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

function dot(left: number[], right: number[]) {
  return left.reduce((total, value, index) => total + value * right[index]!, 0);
}

function mean(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function solve(matrix: number[][], vector: number[]) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1)
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[best]![pivot]!)) best = row;
    [augmented[pivot], augmented[best]] = [augmented[best]!, augmented[pivot]!];
    const divisor = augmented[pivot]![pivot]!;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]! / divisor;
      for (let column = pivot; column <= size; column += 1)
        augmented[row]![column]! -= factor * augmented[pivot]![column]!;
    }
  }
  return augmented.map((row, index) => row[size]! / row[index]!);
}
