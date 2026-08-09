function presentProduct(product, remaining) {
  return { ...product.toJSON(), remainingStock: remaining === undefined ? null : remaining };
}

module.exports = { presentProduct };
