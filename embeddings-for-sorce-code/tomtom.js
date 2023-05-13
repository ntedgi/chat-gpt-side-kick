class Operator1{
    a(){
        return "name"
    }
}

function tomtom1(number) {
    let x = 0
    for (var i = 0; i < number; i++) {
        x += 1
    }
    return x

}
function tomtom2(number) {
    return number * (number + 1) / 2;
}
function compare(number){
    console.log(tomtom1(number)===tomtom2(number))
}
compare(1)
compare(10)
compare(7)

function naorTest(number){
    return number+3
}