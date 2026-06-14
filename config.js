// The deploy workflow replaces __ROADBITE_KEY__ with the ROADBITE_KEY repo secret
// at publish time, so the real key is never committed to source. When running
// locally (no injection) the placeholder is ignored and you can paste a key in ⚙︎.
window.ROADBITE_KEY = "__ROADBITE_KEY__";
