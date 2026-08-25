const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../app/lib/dwg-tools.cjs');

test('routing PHKT check only uses no-network routing problem rows', () => {
  const html = `
    <h3>cable: Routing problem (2)</h3>
    <table>
      <tr>
        <th>id</th><th>label</th><th>locatienaam_a</th><th>locatienaam_b</th><th>Error message</th>
      </tr>
      <tr>
        <td>40</td><td>K-WND-AAB-ODP001-KA35</td><td>Wnd-AAB-ODP001</td><td>8857BK-33</td>
        <td>AccessNet (159885.989,578853.856) -> (159879.000,578819.000): No network connection found within 0,1 m from the point (159879.000,578819.000)</td>
      </tr>
      <tr>
        <td>89</td><td>K-WND-AAB-ODP002-KA40</td><td>Wnd-AAB-ODP002</td><td>8857BL-15</td>
        <td>AccessNet (159884.610,578628.954) -> (159937.510,578734.772): No route found between start and end</td>
      </tr>
    </table>
  `;

  assert.deepEqual(_internal.parseRoutingProblemLabelsFromCheckHtml(html), ['8857BK-33']);
});
