
const DATASET_ID = "0dfad294-f852-45a5-b86f-986773745fe2";
const CKAN = "https://www.data.qld.gov.au/api/3/action";

function monthValue(name=""){
  const m=name.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  return m ? Date.parse(`${m[1]} 1, ${m[2]}`)||0 : 0;
}
function norm(v=""){return String(v).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function fuelMatches(actual,requested){
  const a=norm(actual),r=norm(requested);
  if(r.includes("e10")) return a.includes("e10");
  if(r.includes("98")) return a.includes("98");
  if(r.includes("95")) return a.includes("95");
  if(r.includes("diesel")) return a.includes("diesel");
  if(r.includes("91")||r.includes("unleaded"))
    return (a.includes("unleaded")||a==="ulp"||a.includes("91"))&&!a.includes("e10")&&!a.includes("95")&&!a.includes("98");
  return a.includes(r);
}
function priceToDollars(raw){
  const p=Number(raw);
  if(!Number.isFinite(p))return null;
  if(p>500)return p/1000;   // e.g. 1840 -> $1.840/L
  if(p>10)return p/100;
  return p;
}
function haversine(a,b,c,d){
  const R=6371,rad=x=>x*Math.PI/180;
  const dLat=rad(c-a),dLon=rad(d-b);
  const q=Math.sin(dLat/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(q));
}
async function latestResource(){
  const r=await fetch(`${CKAN}/package_show?id=${encodeURIComponent(DATASET_ID)}`);
  if(!r.ok)throw new Error("Queensland dataset metadata request failed.");
  const j=await r.json();
  if(!j.success)throw new Error("Queensland dataset metadata unavailable.");
  const resources=(j.result.resources||[])
    .filter(x=>x.datastore_active&&/Queensland Fuel Prices/i.test(x.name||""))
    .sort((a,b)=>monthValue(b.name)-monthValue(a.name));
  if(!resources.length)throw new Error("No Queensland fuel dataset found.");
  return resources[0];
}
async function sql(resourceId,where){
  const statement=`SELECT * FROM "${resourceId}" WHERE ${where} LIMIT 50000`;
  const u=`${CKAN}/datastore_search_sql?sql=${encodeURIComponent(statement)}`;
  const r=await fetch(u);
  if(!r.ok)throw new Error("Queensland data query failed.");
  const j=await r.json();
  if(!j.success)throw new Error(j.error?.message||"Queensland data query failed.");
  return j.result.records||[];
}
async function suburbRows(resourceId,suburb){
  const p=new URLSearchParams({resource_id:resourceId,limit:"5000",q:suburb});
  const r=await fetch(`${CKAN}/datastore_search?${p}`);
  if(!r.ok)throw new Error("Queensland suburb lookup failed.");
  const j=await r.json();
  if(!j.success)throw new Error("Queensland suburb lookup failed.");
  return j.result.records||[];
}
function latestByStation(records){
  records.sort((a,b)=>new Date(b.TransactionDateutc||0)-new Date(a.TransactionDateutc||0));
  const out=new Map();
  for(const r of records){
    const k=`${r.SiteId||r.Site_Name}|${norm(r.Fuel_Type)}`;
    if(!out.has(k))out.set(k,r);
  }
  return [...out.values()];
}

exports.handler=async event=>{
  try{
    const q=event.queryStringParameters||{};
    const fuelType=(q.fuelType||"Unleaded 91").trim();
    const lat=Number(q.lat),lon=Number(q.lon);
    const radius=Math.min(30,Math.max(1,Number(q.radius)||8));
    const suburb=(q.suburb||"").trim();
    const gps=Number.isFinite(lat)&&Number.isFinite(lon);

    if(!gps&&suburb.length<2)
      return {statusCode:400,headers:{"content-type":"application/json"},body:JSON.stringify({error:"Enter a suburb or allow location access."})};

    const resource=await latestResource();
    let records=[];

    if(gps){
      // Bounding box first. Rough degree conversion is plenty for an 8–30 km local search.
      const latDelta=radius/111;
      const lonDelta=radius/(111*Math.max(0.2,Math.cos(lat*Math.PI/180)));
      const minLat=lat-latDelta,maxLat=lat+latDelta,minLon=lon-lonDelta,maxLon=lon+lonDelta;

      records=await sql(resource.id,
        `"Site_Latitude" >= ${minLat} AND "Site_Latitude" <= ${maxLat} `+
        `AND "Site_Longitude" >= ${minLon} AND "Site_Longitude" <= ${maxLon}`
      );

      records=records.map(r=>{
        const rlat=Number(r.Site_Latitude),rlon=Number(r.Site_Longitude);
        if(!Number.isFinite(rlat)||!Number.isFinite(rlon))return null;
        return {...r,_distance:haversine(lat,lon,rlat,rlon)};
      }).filter(Boolean).filter(r=>r._distance<=radius);
    }else{
      records=await suburbRows(resource.id,suburb);
      const s=norm(suburb);
      records=records.filter(r=>{
        const x=norm(r.Site_Suburb||"");
        return x===s||x.includes(s)||s.includes(x);
      });
    }

    records=records.filter(r=>fuelMatches(r.Fuel_Type||"",fuelType));
    const latest=latestByStation(records);

    const rows=latest.map(r=>({
      siteId:r.SiteId,
      name:r.Site_Name||"Service station",
      brand:r.Site_Brand||"",
      suburb:r.Site_Suburb||"",
      fuelType:r.Fuel_Type||"",
      price:priceToDollars(r.Price),
      timestamp:r.TransactionDateutc||null,
      distance:Number.isFinite(r._distance)?r._distance:null,
      lat:Number(r.Site_Latitude),
      lon:Number(r.Site_Longitude)
    })).filter(r=>Number.isFinite(r.price)&&r.price>0);

    if(!rows.length){
      return {statusCode:404,headers:{"content-type":"application/json"},body:JSON.stringify({
        error:gps
          ? `No ${fuelType} price records were found within ${radius} km in ${resource.name}.`
          : `No ${fuelType} price records were found for "${suburb}" in ${resource.name}.`,
        dataset:resource.name,
        debug:{rawNearbyRecords:records.length}
      })};
    }

    const prices=rows.map(x=>x.price).sort((a,b)=>a-b);
    const n=prices.length,m=Math.floor(n/2);
    const median=n%2?prices[m]:(prices[m-1]+prices[m])/2;
    const cheapest=[...rows].sort((a,b)=>a.price-b.price||(a.distance??999)-(b.distance??999)).slice(0,5);
    const closest=[...rows].filter(x=>Number.isFinite(x.distance)).sort((a,b)=>a.distance-b.distance).slice(0,5);
    const latestTimestamp=rows.map(x=>x.timestamp).filter(Boolean).sort().reverse()[0]||null;

    return {statusCode:200,headers:{"content-type":"application/json","cache-control":"public,max-age=1800"},body:JSON.stringify({
      source:"Queensland Government Open Data",
      dataset:resource.name,
      mode:gps?"gps":"suburb",
      fuelType,
      radiusKm:gps?radius:null,
      stationCount:rows.length,
      medianPrice:median,
      cheapestPrice:prices[0],
      latestTimestamp,
      cheapest,
      closest
    })};
  }catch(e){
    return {statusCode:500,headers:{"content-type":"application/json"},body:JSON.stringify({error:e.message||"Fuel lookup failed."})};
  }
};
