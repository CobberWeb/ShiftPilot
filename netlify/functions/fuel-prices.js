
const DATASET_ID = "0dfad294-f852-45a5-b86f-986773745fe2";
const CKAN = "https://www.data.qld.gov.au/api/3/action";

function monthValue(name = "") {
  const m = name.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!m) return 0;
  return Date.parse(`${m[1]} 1, ${m[2]}`) || 0;
}

function normalize(s = "") {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fuelMatches(actual, requested) {
  const a = normalize(actual);
  const r = normalize(requested);

  if (r.includes("e10")) return a.includes("e10");
  if (r.includes("98")) return a.includes("98");
  if (r.includes("95")) return a.includes("95");
  if (r.includes("diesel")) return a.includes("diesel");
  if (r.includes("91") || r.includes("unleaded")) {
    // Match regular unleaded, but avoid E10 and premium grades.
    return (a.includes("unleaded") || a === "ulp" || a.includes("91")) &&
           !a.includes("e10") && !a.includes("95") && !a.includes("98");
  }
  return a.includes(r);
}

function priceToDollars(raw) {
  const p = Number(raw);
  if (!Number.isFinite(p)) return null;
  // QLD dataset commonly stores 1799 for 179.9 c/L.
  if (p > 500) return p / 1000;
  if (p > 10) return p / 100;
  return p;
}

exports.handler = async function(event) {
  try {
    const suburb = (event.queryStringParameters?.suburb || "").trim();
    const fuelType = (event.queryStringParameters?.fuelType || "Unleaded 91").trim();

    if (suburb.length < 2) {
      return { statusCode: 400, headers: {"content-type":"application/json"}, body: JSON.stringify({error:"Enter a suburb or area."}) };
    }

    // Find the newest published monthly resource dynamically.
    const pkgResp = await fetch(`${CKAN}/package_show?id=${encodeURIComponent(DATASET_ID)}`);
    if (!pkgResp.ok) throw new Error("Queensland dataset metadata request failed.");
    const pkg = await pkgResp.json();
    if (!pkg.success) throw new Error("Queensland dataset metadata was unavailable.");

    const resources = (pkg.result.resources || [])
      .filter(r => r.datastore_active && /Queensland Fuel Prices/i.test(r.name || ""))
      .sort((a,b) => monthValue(b.name) - monthValue(a.name));

    if (!resources.length) throw new Error("No Queensland fuel-price resources were found.");
    const resource = resources[0];

    // Use CKAN full-text q to avoid unsafe SQL construction, then filter precisely here.
    const params = new URLSearchParams({
      resource_id: resource.id,
      limit: "5000",
      q: suburb
    });

    const dsResp = await fetch(`${CKAN}/datastore_search?${params.toString()}`);
    if (!dsResp.ok) throw new Error("Queensland fuel-price data request failed.");
    const ds = await dsResp.json();
    if (!ds.success) throw new Error("Queensland fuel-price data was unavailable.");

    const q = normalize(suburb);
    const matched = (ds.result.records || []).filter(row => {
      const s = normalize(row.Site_Suburb || row["Site_Suburb"] || "");
      return (s === q || s.includes(q) || q.includes(s)) && fuelMatches(row.Fuel_Type || row["Fuel_Type"] || "", fuelType);
    });

    // Monthly files can contain multiple price changes for the same station.
    // Keep the most recent record per station + fuel.
    matched.sort((a,b) => new Date(b.TransactionDateutc || 0) - new Date(a.TransactionDateutc || 0));
    const latestByStation = new Map();
    for (const row of matched) {
      const key = `${row.SiteId || row.Site_Name}|${normalize(row.Fuel_Type)}`;
      if (!latestByStation.has(key)) latestByStation.set(key, row);
    }

    const rows = [...latestByStation.values()].map(row => ({
      siteId: row.SiteId,
      name: row.Site_Name || "Service station",
      brand: row.Site_Brand || "",
      suburb: row.Site_Suburb || "",
      fuelType: row.Fuel_Type || "",
      price: priceToDollars(row.Price),
      timestamp: row.TransactionDateutc || null
    })).filter(x => Number.isFinite(x.price) && x.price > 0);

    if (!rows.length) {
      const availableFuelTypes = [...new Set((ds.result.records || [])
        .filter(r => normalize(r.Site_Suburb || "").includes(q))
        .map(r => r.Fuel_Type).filter(Boolean))].sort();
      return {
        statusCode: 404,
        headers: {"content-type":"application/json"},
        body: JSON.stringify({
          error:`No ${fuelType} prices were found for "${suburb}" in the latest government snapshot.`,
          dataset: resource.name,
          availableFuelTypes
        })
      };
    }

    const prices = rows.map(x=>x.price).sort((a,b)=>a-b);
    const middle = Math.floor(prices.length/2);
    const median = prices.length % 2 ? prices[middle] : (prices[middle-1]+prices[middle])/2;
    const latestTimestamp = rows.map(x=>x.timestamp).filter(Boolean).sort().reverse()[0] || null;
    const cheapest = rows.sort((a,b)=>a.price-b.price).slice(0,5);

    return {
      statusCode: 200,
      headers: {
        "content-type":"application/json",
        "cache-control":"public, max-age=1800"
      },
      body: JSON.stringify({
        source:"Queensland Government Open Data",
        dataset: resource.name,
        datasetResourceId: resource.id,
        suburb,
        requestedFuelType:fuelType,
        stationCount:rows.length,
        medianPrice:median,
        cheapestPrice:prices[0],
        highestPrice:prices[prices.length-1],
        latestTimestamp,
        cheapest
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {"content-type":"application/json"},
      body: JSON.stringify({error:err.message || "Fuel price lookup failed."})
    };
  }
};
