
async function testRegex() {
  const content = '<a href="/news/art1">News 1</a> and <a href="/news/art2">News 2</a>';
  const regex = /href="([^"]+)"/g;
  let m;
  const links = [];
  while ((m = regex.exec(content)) !== null) {
      links.push(m[1]);
  }
  console.log("Links found:", links);
}
testRegex();
