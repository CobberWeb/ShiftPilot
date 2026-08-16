
const DATASET_ID = "0dfad294-f852-45a5-b86f-986773745fe2";
const CKAN = "https://www.data.qld.gov.au/api/3/action";

function monthValue(name = "") {
  const m = name.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!m) return 0;
  return Date.parse(`${m[1]} 1, ${m[2]}`) || 0;
}
function norm(v=""){ return String(v).toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function fuelMatches(actual, requested) {
  const a=norm(actual), r=norm(requested);
  if(r.includes("e10")) return a.includes("e10");
  if(r.includes("98")) return a.includes("98");
  if(r.includes("95")) return a.includes("95");
  if(r.includes("diesel")) return a.includes("diesel");
  if(r.includes("91") || r.includes("unleaded"))
    return (a.includes("unleaded")||a==="ulp"||a.includes("91")) && !a.includes("e10")&&!a.includes("95")&&!a.includes("98");
  return a.includes(r);
}
function priceToDollars(raw){
  const p=Number(raw);
  if(!Number.isFinite(p)) return null;
  if(p>500) return p/1000;
  if(p>10) return p/100;
  return p;
}
function field(row, names){
  for(const n of names) if(row[n] !== undefined && row[n] !== null && row[n] !== "") return row[n];
  return null;
}
function latOf(row){ return Number(field(row,["Site_Latitude","Latitude","SiteLatitude","lat","Lat"])); }
function lonOf(row){ return Number(field(row,["Site_Longitude","Longitude","SiteLongitude","lon","lng","Long"])); }
function haversine(lat1,lon1,lat2,lon2){
  const R=6371, toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function latestPerStation(records){
  records.sort((a,b)=>new Date(b.TransactionDateutc||0)-new Date(a.TransactionDateutc||0));
  const m=new Map();
  for(const r of records){
    const k=`${r.SiteId||r.Site_Name}|${norm(r.Fuel_Type)}`;
    if(!m.has(k)) m.set(k,r);
  }
  return [...m.values()];
}
async function latestResource(){
  const resp=await fetch(`${CKAN}/package_show?id=${encodeURIComponent(DATASET_ID)}`);
  if(!resp.ok) throw new Error("Queensland dataset metadata request failed.");
  const body=await resp.json();
  if(!body.success) throw new Error("Queensland dataset metadata was unavailable.");
  const resources=(body.result.resources||[])
    .filter(r=>r.datastore_active && /Queensland Fuel Prices/i.test(r.name||""))
    .sort((a,b)=>monthValue(b.name)-monthValue(a.name));
  if(!resources.length) throw new Error("No Queensland fuel-price resources were found.");
  return resources[0];
}
async function fetchRows(resourceId, q=null){
  const params=new URLSearchParams({resource_id:resourceId,limit:"10000"});
  if(q) params.set("q",q);
  const resp=await fetch(`${CKAN}/datastore_search?${params}`);
  if(!resp.ok) throw new Error("Queensland fuel-price data request failed.");
  const body=await resp.json();
  if(!body.success) throw new Error("Queensland fuel-price data was unavailable.");
  return body.result.records||[];
}

exports.handler=async function(event){
  try{
    const p=event.queryStringParameters||{};
    const suburb=(p.suburb||"").trim();
    const fuelType=(p.fuelType||"Unleaded 91").trim();
    const lat=Number(p.lat), lon=Number(p.lon);
    const radius=Math.min(30,Math.max(1,Number(p.radius)||8));
    const useGps=Number.isFinite(lat)&&Number.isFinite(lon);

    if(!useGps && suburb.length<2){
      return {statusCode:400,headers:{"content-type":"application/json"},body:JSON.stringify({error:"Enter a suburb or allow location access."})};
    }

    const resource=await latestResource();
    // For suburb lookups use CKAN's q search. For GPS we fetch the current resource and filter by coordinates.
    const raw=await fetchRows(resource.id,useGps?null:suburb);

    let candidates=raw.filter(r=>fuelMatches(r.Fuel_Type||"",fuelType));

    if(useGps){
      candidates=candidates.map(r=>{
        const rlat=latOf(r), rlon=lonOf(r);
        if(!Number.isFinite(rlat)||!Number.isFinite(rlon)) return null;
        return {...r,_distance:haversine(lat,lon,rlat,rlon)};
      }).filter(Boolean).filter(r=>r._distance<=radius);
    }else{
      const q=norm(suburb);
      candidates=candidates.filter(r=>{
        const s=norm(r.Site_Suburb||"");
        return s===q||s.includes(q)||q.includes(s);
      });
    }

    const latest=latestPerStation(candidates);
    const rows=latest.map(r=>({
      siteId:r.SiteId,
      name:r.Site_Name||"Service station",
      brand:r.Site_Brand||"",
      suburb:r.Site_Suburb||"",
      fuelType:r.Fuel_Type||"",
      price:priceToDollars(r.Price),
      timestamp:r.TransactionDateutc||null,
      distance:Number.isFinite(r._distance)?r._distance:null,
      lat:Number.isFinite(latOf(r))?latOf(r):null,
      lon:Number.isFinite(lonOf(r))?lonOf(r):null
    })).filter(x=>Number.isFinite(x.price)&&x.price>0);

    if(!rows.length){
      return {statusCode:404,headers:{"content-type":"application/json"},body:JSON.stringify({
        error:useGps
          ? `No ${fuelType} stations were found within ${radius} km in the latest government snapshot.`
          : `No ${fuelType} prices were found for "${suburb}" in the latest government snapshot.`,
        dataset:resource.name
      })};
    }

    const prices=rows.map(x=>x.price).sort((a,b)=>a-b);
    const mid=Math.floor(prices.length/2);
    const median=prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2;
    const latestTimestamp=rows.map(x=>x.timestamp).filter(Boolean).sort().reverse()[0]||null;
    const cheapest=[...rows].sort((a,b)=>a.price-b.price || (a.distance??999)-(b.distance??999)).slice(0,5);
    const closest=[...rows].filter(x=>Number.isFinite(x.distance)).sort((a,b)=>a.distance-b.distance).slice(0,5);

    return {statusCode:200,headers:{"content-type":"application/json","cache-control":"public, max-age=1800"},body:JSON.stringify({
      source:"Queensland Government Open Data",
      dataset:resource.name,
      mode:useGps?"gps":"suburb",
      fuelType,
      radiusKm:useGps?radius:null,
      stationCount:rows.length,
      medianPrice:median,
      cheapestPrice:prices[0],
      latestTimestamp,
      cheapest,
      closest
    })};
  }catch(err){
    return {statusCode:500,headers:{"content-type":"application/json"},body:JSON.stringify({error:err.message||"Fuel price lookup failed."})};
  }
};
