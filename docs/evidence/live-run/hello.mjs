/**
 * hello.mjs — minimal greeting module.
 *
 * No external dependencies: this file only uses the JavaScript language
 * itself and is consumed via Node's built-in ES module loader.
 */

/**
 * Build a greeting for the given name.
 *
 * Contract: the returned string is always `Hello, ` + name + `!`.
 * The name is used verbatim — it is not trimmed, validated, or
 * special-cased. An empty string therefore yields `Hello, !`.
 *
 * @param {string} name - The name to greet.
 * @returns {string} `Hello, <name>!`
 */
export function greet(name) {
  return `Hello, ${name}!`;
}
