import { abi, contractAddress } from './contract.js';

// Use ethers from global window (UMD)
const { ethers } = window;

let signer, contract;
let domainList = [];

// Your Pinata JWT token here
const PINATA_JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiIxZjhmYjExNy0wOWI0LTRmMjItODMzOS0zY2EwOTFhYzU5MzgiLCJlbWFpbCI6ImRlZXBhbHNocnRAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsInBpbl9wb2xpY3kiOnsicmVnaW9ucyI6W3siZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiRlJBMSJ9LHsiZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiTllDMSJ9XSwidmVyc2lvbiI6MX0sIm1mYV9lbmFibGVkIjpmYWxzZSwic3RhdHVzIjoiQUNUSVZFIn0sImF1dGhlbnRpY2F0aW9uVHlwZSI6InNjb3BlZEtleSIsInNjb3BlZEtleUtleSI6ImVlMDUxYTVjNTQxODFiOTlmOTc0Iiwic2NvcGVkS2V5U2VjcmV0IjoiYTgwZDc5YWM5M2I5YzQzYTU4NzJjNTA5MjI4YmEyNmEzNmM2NDBhNTY2NjUwNWZiYzZjYjFjNDJiNWQzY2Q2YyIsImV4cCI6MTc4MDQ4ODIxM30.ZQfFomgkfxEbIdpVBbg2xaXjgeu3pgkbxhzGN8vYBOY";

document.getElementById('connectWallet').onclick = async () => {
  if (!window.ethereum) {
    alert("Please install MetaMask!");
    return;
  }
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  signer = provider.getSigner();
  contract = new ethers.Contract(contractAddress, abi, signer);
  const address = await signer.getAddress();
  document.getElementById('walletAddress').innerText = 'Connected: ' + address;

  // Load past domains on connect
  await loadPastDomains();

  // Listen for new DomainRegistered events live
  contract.on("DomainRegistered", (name, owner, cid) => {
    console.log(`New domain registered: ${name} by ${owner} with CID ${cid}`);

    if (!domainList.find(d => d.name === name)) {
      domainList.push({ name, owner, cid });
      updateDomainListUI();
    }
  });
};

async function uploadToPinata(file) {
  const url = "https://api.pinata.cloud/pinning/pinFileToIPFS";
  const data = new FormData();
  data.append('file', file);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PINATA_JWT_TOKEN}`,
    },
    body: data
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Pinata upload failed: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const json = await res.json();
  return json.IpfsHash; // preserve exact CID casing here
}

// Register Domain
document.getElementById('registerBtn').onclick = async () => {
  const domain = document.getElementById('domainInput').value.trim();
  const fileInput = document.getElementById('fileInput');

  if (!domain) {
    alert("Please enter a domain name");
    return;
  }
  if (fileInput.files.length === 0) {
    alert("Please select a file");
    return;
  }

  try {
    const cid = await uploadToPinata(fileInput.files[0]);
    console.log("Uploaded CID (case preserved):", cid);

    const tx = await contract.registerDomain(domain, cid);
    await tx.wait();

    document.getElementById('registerStatus').innerText = `Registered ${domain} with CID: ${cid}`;
  } catch (error) {
    console.error(error);
    alert("Error registering domain: " + error.message);
  }
};

// Resolve Domain
// Resolve & Preview the site stored as a ZIP on IPFS
document.getElementById('resolveBtn').onclick = async () => {
  const domain = document.getElementById('resolveInput').value.trim();
  const statusEl = document.getElementById('resolveStatus');
  const miniBrowser = document.getElementById('miniBrowser');

  // Reset UI
  statusEl.textContent = '';
  miniBrowser.innerHTML = '';
  document.getElementById('resolvedDomain').textContent = '';
  document.getElementById('resolvedCid').textContent = '';

  if (!domain) return alert("Please enter a domain.");

  try {
    const cid = await contract.getCID(domain);
    if (!cid) throw new Error("No CID registered for this domain.");

    document.getElementById('resolvedDomain').textContent = domain;
    document.getElementById('resolvedCid').textContent = cid;

    statusEl.innerText = `📦 Fetching ZIP from IPFS...`;
    const response = await fetch(`https://ipfs.io/ipfs/${cid}`);
    const buffer = await response.arrayBuffer();

    const zip = await JSZip.loadAsync(buffer);
    const files = {}, blobs = {};

    // Load all files into memory and create blob URLs
    await Promise.all(Object.entries(zip.files).map(async ([name, file]) => {
      const content = await file.async('string');
      let type = 'text/plain';
      if (name.endsWith('.js')) type = 'application/javascript';
      else if (name.endsWith('.css')) type = 'text/css';
      else if (name.endsWith('.html')) type = 'text/html';

      const blob = new Blob([content], { type });
      files[name] = content;
      blobs[name] = URL.createObjectURL(blob);
    }));

    // Find index.html
    const indexPath = Object.keys(files).find(n => n.endsWith('index.html'));
    if (!indexPath) throw new Error("No index.html found in ZIP.");

    // Rewrite src/href references to blob URLs
    let html = files[indexPath];
    html = html.replace(/(src|href)=["']([^"']+)["']/g, (_, attr, path) => {
      return blobs[path] ? `${attr}="${blobs[path]}"` : `${attr}="${path}"`;
    });

    // Create and inject iframe
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.width = '100%';
    iframe.style.height = '600px';
    iframe.style.border = '1px solid #ccc';
    iframe.srcdoc = html;
    miniBrowser.appendChild(iframe);

    statusEl.innerText = '✅ Site preview loaded!';
  } catch (err) {
    console.error("Preview error:", err);
    statusEl.innerText = '❌ Preview failed.';
    alert("Failed to render site: " + err.message);
  }
};


// Transfer Domain Ownership
document.getElementById('transferDomainBtn').onclick = async () => {
  const domain = document.getElementById('transferDomainInput').value.trim();
  const newOwner = document.getElementById('newOwnerInput').value.trim();

  if (!domain || !ethers.utils.isAddress(newOwner)) {
    alert("Please enter valid domain and new owner address");
    return;
  }

  try {
    const tx = await contract.transferDomain(domain, newOwner);
    await tx.wait();
    document.getElementById('transferDomainStatus').innerText = `Ownership transferred for ${domain} to ${newOwner}`;
  } catch (error) {
    console.error(error);
    alert("Error transferring ownership: " + error.message);
  }
};

// Update domain list UI table
function updateDomainListUI() {
  const tbody = document.getElementById('domainsTable');
  tbody.innerHTML = ''; // Clear existing rows

  domainList.forEach(domain => {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.innerText = domain.name;
    row.appendChild(nameCell);

    const cidCell = document.createElement('td');
    cidCell.innerText = domain.cid;
    row.appendChild(cidCell);

    tbody.appendChild(row);
  });
}

// Load past registered domains by querying past events
async function loadPastDomains() {
  try {
    const filter = contract.filters.DomainRegistered();
    const events = await contract.queryFilter(filter, 0, "latest");

    domainList = events.map(event => ({
      name: event.args.name,
      owner: event.args.owner,
      cid: event.args.cid
    }));

    updateDomainListUI();
  } catch (error) {
    console.error("Failed to load past domains:", error);
  }
}