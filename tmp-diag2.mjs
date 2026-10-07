const HEAD = "(^|" + String.fromCharCode(92) + "s|&|;|&&|" + String.fromCharCode(92, 92) + "|" + String.fromCharCode(92, 92) + "|)";
const npmPart = HEAD + "npm" + String.fromCharCode(92) + "s+(?:--?[a-z-]+" + String.fromCharCode(92) + "s+)*-?test(?::[A-Za-z0-9._-]+)?(?=" + String.fromCharCode(92) + "s|$)";
const re = new RegExp(npmPart);
for (const c of ["npm run test", "npm --test", "npm test:later"]) console.log(JSON.stringify(c), re.test(c));
console.log("source:", npmPart);
