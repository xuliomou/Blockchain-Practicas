import React, { useEffect, useState } from "react";
import './App.css';
import { create } from 'kubo-rpc-client'
import { ethers } from "ethers"
import { Buffer } from "buffer"

import logo from "./ethereumLogo.png"
import { addresses, abis } from "./contracts"

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const defaultProvider = new ethers.providers.Web3Provider(window.ethereum);

const ipfsContract = new ethers.Contract(
  addresses.ipfs,
  abis.ipfs,
  defaultProvider
);

// Lee del contrato el hash guardado para la cuenta conectada
async function readCurrentUserFile() {
  const result = await ipfsContract.userFiles(
    defaultProvider.getSigner().getAddress()
  );
  console.log({ result });
  return result;
}

function App() {
  const [ipfsHash, setIpfsHash] = useState("");
  const [file, setFile] = useState(null);

  // Pide permiso a MetaMask para conectar la cuenta
  useEffect(() => {
    window.ethereum.enable();
  }, []);

  useEffect(() => {
    async function readFile() {
      const file = await readCurrentUserFile();
      if (file !== ZERO_ADDRESS) setIpfsHash(file);
    }
    readFile();
  }, []);

  // Guarda el hash en Ethereum llamando al smart contract
  async function setFileIPFS(hash) {
    const ipfsWithSigner = ipfsContract.connect(defaultProvider.getSigner());
    console.log("TX contract");
    const tx = await ipfsWithSigner.setFileIPFS(hash);
    console.log({ tx });
    setIpfsHash(hash);
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      console.log(file)
      // conectar a la instancia en local de ipfs
      // (el guion usa /ip4/0.0.0.0/tcp/5001; se usa 127.0.0.1 porque algunos
      // navegadores bloquean las peticiones a 0.0.0.0)
      const client = await create('/ip4/127.0.0.1/tcp/5001')
      // añadir el archivo a ipfs
      const result = await client.add(file)
      // añadir al fs del nodo ipfs en local para poder visualizarlo en el dashboard
      await client.files.cp(`/ipfs/${result.cid}`, `/${result.cid}`)
      console.log(result.cid)
      // añadir el CID de ipfs a ethereum a traves del smart contract
      await setFileIPFS(result.cid.toString());
    } catch (error) {
      console.log(error.message);
    }
  };

  const retrieveFile = (e) => {
    const data = e.target.files[0];
    const reader = new window.FileReader();
    reader.readAsArrayBuffer(data);
    console.log(data);
    reader.onloadend = () => {
      console.log("Buffer data: ", Buffer.from(reader.result));
      setFile(Buffer.from(reader.result));
    }
    e.preventDefault();
  }

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Upload a file to store it on IPFS and save the hash on ethereum.
        </p>
        <form className="form" onSubmit={handleSubmit}>
          <input type="file" name="data" onChange={retrieveFile} />
          <button type="submit" className="btn">Upload</button>
        </form>
        {ipfsHash && <p>Último CID guardado: {ipfsHash}</p>}
      </header>
    </div>
  );
}

export default App;
