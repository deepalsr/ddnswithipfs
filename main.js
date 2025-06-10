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
  const iframe = document.getElementById('zipPreviewFrame');

  // Reset status and iframe
  statusEl.innerText = '';
  iframe.srcdoc = '';

  if (!domain) {
    return alert("Please enter a domain to resolve.");
  }

  try {
    // 1) Get the CID from-chain
    const cid = await contract.getCID(domain);
    if (!cid) {
      return alert("No CID found for this domain.");
    }

    statusEl.innerText = `Fetching ZIP (CID: ${cid})…`;

    // 2) Fetch the ZIP file from IPFS
    const zipUrl = `https://ipfs.io/ipfs/${cid}`;
    const response = await fetch(zipUrl);
    if (!response.ok) {
      throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();

    statusEl.innerText = 'Unpacking ZIP…';

    // 3) Load in JSZip
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 4) Turn every file into a blob URL
    const fileURLMap = {};
    await Promise.all(
      Object.values(zip.files).map(async file => {
        const blob = await file.async('blob');
        fileURLMap[file.name] = URL.createObjectURL(blob);
      })
    );

    statusEl.innerText = 'Rewriting index.html…';

    // 5) Grab index.html, rewrite its resource URLs
    if (!zip.files['index.html']) {
      throw new Error("ZIP does not contain an index.html at the root.");
    }
    const rawHtml = await zip.files['index.html'].async('string');
    const rewrittenHtml = rawHtml.replace(
      /(href|src)=["']([^"']+)["']/g,
      (match, attr, path) => {
        // If we have a blob URL for this path, inject it
        return fileURLMap[path]
          ? `${attr}="${fileURLMap[path]}"`
          : match;
      }
    );

    statusEl.innerText = 'Rendering site…';

    // 6) Inject into iframe
    iframe.srcdoc = rewrittenHtml;
    statusEl.innerText = '✅ Site preview ready!';

  } catch (err) {
    console.error("Resolve & Preview error:", err);
    alert("Error previewing site: " + err.message);
    statusEl.innerText = '⚠️ Preview failed.';
  }
};


// Check Ownership
document.getElementById('checkOwnershipBtn').onclick = async () => {
  const domain = document.getElementById('ownershipInput').value.trim();

  if (!domain) {
    alert("Please enter a domain name to check ownership");
    return;
  }

  try {
    const owner = await contract.getOwner(domain);
    document.getElementById('ownershipStatus').innerText = `Owner: ${owner}`;
  } catch (error) {
    console.error(error);
    alert("Error checking ownership: " + error.message);
  }
};

// Update CID
document.getElementById('updateCidBtn').onclick = async () => {
  const domain = document.getElementById('updateDomainInput').value.trim();
  const newCid = document.getElementById('newCidInput').value.trim();

  if (!domain || !newCid) {
    alert("Please enter both domain and new CID");
    return;
  }

  try {
    console.log("Updating CID to (case preserved):", newCid);
    const tx = await contract.updateCID(domain, newCid);
    await tx.wait();
    document.getElementById('updateCidStatus').innerText = `CID updated for ${domain}`;
  } catch (error) {
    console.error(error);
    alert("Error updating CID: " + error.message);
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
