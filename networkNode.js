const express = require( 'express' )
const path = require('path');
const bodyParser = require( 'body-parser' )
const app = express()
const uuid = require( 'uuid/v1' )
const port = process.argv[2]
const rp = require( 'request-promise' )

const nodeAdress = uuid().split('-').join('')

const Blockchain = require( './blockchain.js' )
const bitcoin = new Blockchain()

app.use( bodyParser.json() )
app.use( bodyParser.urlencoded({ extended: false }) )
app.use('/libs', express.static(path.join(__dirname, '/libs')));
app.use('/public', express.static(path.join(__dirname, '/public')));
app.use('/block-explorer', express.static(path.join(__dirname, '/block-explorer')));

app.get( '/blockchain', function( req, res ) {
  res.send( bitcoin )
})

app.post( '/transaction', function( req, res ) {

  const newTransaction = req.body
  const blockIndex = bitcoin.addTransactionToPedingTransactions( newTransaction )
  res.json( { note: `transaction will be added in block ${blockIndex}` } )

})

app.post( '/transaction/broadcast', function( req, res ) {

  const newTransaction = bitcoin.createNewTransaction( req.body.amout, req.body.sender, req.body.recipient )
  bitcoin.addTransactionToPedingTransactions( newTransaction )

  const requestPromises = []
  bitcoin.networkNodes.forEach( networkNodeUrl => {
    const requestOptions = {
        uri: networkNodeUrl + "/transaction",
        method: 'POST',
        body: newTransaction,
        json: true,
    }

    requestPromises.push( rp(requestOptions) )
  })

  Promise.all( requestPromises )
  .then( data => {
    res.json( { note: 'Transaction created and broadcast succefully' })
  })
})


app.get( '/mine', function( req, res ) {
  const lastBlock = bitcoin.getLastBlock()
  const previousBlockHash = lastBlock.hash

  const currentBlockData = {
    transactions : bitcoin.pendingTransactions,
    index : lastBlock.index + 1,
  }

  const nonce = bitcoin.proofOfWork( previousBlockHash, currentBlockData )
  const blockHash = bitcoin.hashBlock( previousBlockHash, currentBlockData, nonce)

  const newBlock = bitcoin.createNewBlock( nonce, previousBlockHash, blockHash )

  const requestPromises = []
  bitcoin.networkNodes.forEach( networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/receiveNewBlock',
      method: 'POST',
      body: { newBlock: newBlock },
      json: true
    }

    requestPromises.push( rp( requestOptions ) )
  })

  Promise.all( requestPromises )
  .then( data => {
    const requestOptions = {
      uri: bitcoin.currentNodeUrl + '/transaction/broadcast',
      method: 'POST',
      body: {
        amout: 12.5,
        sender: "00",
        recipient: nodeAdress
      },
      json: true
    }

    return rp( requestOptions )
  })
  .then( data => {
    res.json({
      note: "New block mined and broadcast succefully",
      block: newBlock,
    })
  })

})

app.post( '/receiveNewBlock', function( req, res ){
  const newBlock = req.body.newBlock
  const lastBlock = bitcoin.getLastBlock()
  const correctHash = lastBlock.hash === newBlock.previousBlockHash
  const correctIndex = lastBlock['index'] + 1 === newBlock['index']

  if( correctHash && correctIndex ) {
    bitcoin.chain.push( newBlock )
    bitcoin.pendingTransactions = []
    res.json({
      note: 'New block received and accepted',
      newBlock: newBlock
    })
  }
  else{
    res.json({
       note: 'New block rejected',
       newBlock: newBlock
     })
  }
})

// Registrer a node and broadcast to the entire network
app.post( '/registerAndBroadcastNode', function( req, res ){
  const newNodeUrl = req.body.newNodeUrl

  if( bitcoin.networkNodes.indexOf(newNodeUrl) == -1 )
    bitcoin.networkNodes.push( newNodeUrl )

  const regNodesPromises = []
  bitcoin.networkNodes.forEach( networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/registerNode',
      method: 'POST',
      body: { newNodeUrl: newNodeUrl },
      json: true,
    }

    regNodesPromises.push( rp(requestOptions) )
  })


  Promise.all(regNodesPromises)
  .then( data => {
    const bulkRegisterOptions = {
      uri: newNodeUrl + '/registerNodesBulk',
      method: 'POST',
      body: { allNetworkNodes: [ ...bitcoin.networkNodes, bitcoin.currentNodeUrl ] },
      json: true
    }

    return rp( bulkRegisterOptions )
  })
  .then( data => {
    res.json({ note : 'New node registered with network succefully' })
  })
})

//Register a node with the network
app.post( '/registerNode', function( req, res ){
  const newNodeUrl = req.body.newNodeUrl
  const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(newNodeUrl) == -1
  const notCurrentNode = bitcoin.currentNodeUrl !== newNodeUrl
  var note = 'New node registered succefully.'

  if( nodeNotAlreadyPresent && notCurrentNode )
    bitcoin.networkNodes.push( newNodeUrl )
  else
    note = 'Something went wrong'

  res.json({ note: note })
})

//Register multiple nodes at once
app.post( '/registerNodesBulk', function( req, res ){
  const allNetworkNodes = req.body.allNetworkNodes
  var note = 'New node registered succefully.'

  allNetworkNodes.forEach( networkNodeUrl => {
    const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf( networkNodeUrl ) == -1
    const notCurrentNode = bitcoin.currentNodeUrl !== networkNodeUrl

    if( nodeNotAlreadyPresent && notCurrentNode )
      bitcoin.networkNodes.push( networkNodeUrl )
    else
      note = 'Something went wrong'

  })

  res.json({ note: note })
})

app.get( '/consensus', function( req, res ){

  const requestPromises = []
  bitcoin.networkNodes.forEach( networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + "/blockchain",
      method: 'GET',
      json: true
    }

    requestPromises.push( rp(requestOptions) )
  })

  Promise.all( requestPromises )
  .then( blockchains => {
    const currentChainLength = bitcoin.chain.length
    let maxChainLength = currentChainLength
    let newLongestChain = null
    let newPendingTransactions = null

    blockchains.forEach( blockchain => {

      if( blockchain.chain.length > maxChainLength ){
        maxChainLength = blockchain.chain.length;
        newLongestChain = blockchain.chain;
        newPendingTransactions = blockchain.pendingTransactions
      }

    })

    if( !newLongestChain || ( newLongestChain && !bitcoin.chainIsValid( newLongestChain ) ) ){
      res.json({
        note: 'Current chain has not been replaced',
        chain: bitcoin.chain
      })
    }
    else if( newLongestChain && bitcoin.chainIsValid( newLongestChain ) ){
      bitcoin.chain = newLongestChain
      bitcoin.pendingTransactions = newPendingTransactions
      res.json({
        note: 'This chain as been replaced!',
        chain: bitcoin.chain
      })
    }

  })

})


app.get( '/block/:blockHash' , function( req, res ){
  const hash = req.params.blockHash
  const correctBlock = bitcoin.getBlock( hash )
  res.json({ block: correctBlock })
})

app.get( '/transaction/:transactionId', function( req, res ){
  const transactionId = req.params.transactionId
  const transactionData = bitcoin.getTransaction( transactionId )
  res.json({
    transaction: transactionData.transaction,
    block: transactionData.block
   })
})

app.get( '/adress/:adress', function( req, res ){
  const adress = req.params.adress
  const adressData = bitcoin.getAdressData( adress )
  res.json({
    adressData: adressData
  })
})

app.get( '/block-explorer', function( req, res ){
  res.sendFile( './block-explorer/block-explorer.html', { root: __dirname } )
})


app.listen( port, () => {
  console.log( `Running server on port ${port}...` )
})
